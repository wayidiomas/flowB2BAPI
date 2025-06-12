// src/services/edgeFunctionService.js
const { getValidBlingToken } = require("./blingTokenService");
const { getRetryConfig, getTimeout } = require("../config/SyncConfig");
const { 
  logHttpRequest, 
  logHttpResponse, 
  logError, 
  sanitizeData,
  createApiContext 
} = require("../utils/logger");
const { 
  withSupabaseRateLimit,
  rateLimiterManager 
} = require("../utils/rateLimiter");
const delay = require("../utils/delay");

/**
 * Chama uma Edge Function do Supabase com sistema integrado de:
 * - Rate limiting inteligente
 * - Retry com backoff exponencial  
 * - Logging estruturado
 * - Métricas de performance
 * - Sanitização de dados sensíveis
 * 
 * @param {string} url - URL da Edge Function
 * @param {Object} payload - Payload da requisição
 * @param {number} empresa_id - ID da empresa
 * @param {string} accessToken - Token de acesso atual
 * @param {string} refresh_token - Token de atualização
 * @param {Object} options - Opções adicionais
 * @returns {Promise<any>} - Resultado da Edge Function
 */
async function callEdgeFunction(url, payload, empresa_id, accessToken, refresh_token, options = {}) {
  // ===========================
  // CONFIGURAÇÃO E CONTEXTO
  // ===========================
  
  const {
    headers = { "Content-Type": "application/json" },
    context = 'default',
    timeout = getTimeout('edge_function')
  } = options;

  // Obtém configurações de retry baseadas no contexto
  const retryConfig = getRetryConfig(context);
  const {
    maxRetries,
    initialDelay,
    backoffFactor,
    retryOnHttpCodes
  } = { ...retryConfig, ...options };

  // Extrai endpoint para rate limiting específico
  const endpoint = extractEndpoint(url);
  
  // Cria contexto de logging
  const logger = createApiContext(endpoint, 'POST')
    .setContext('empresa_id', Number(empresa_id))
    .setContext('url', sanitizeUrl(url));

  logger.debug('Iniciando chamada Edge Function', { 
    endpoint,
    empresa_id: Number(empresa_id)
  });

  // ===========================
  // PREPARAÇÃO DA REQUISIÇÃO
  // ===========================

  // Assegura que temos um token válido
  const token = await getValidBlingToken(empresa_id, accessToken, refresh_token);
  
  // Monta o payload com o token atualizado
  const finalPayload = {
    ...payload,
    access_token: token,
    empresa_id: Number(empresa_id)
  };

  // ===========================
  // FUNÇÃO DE CHAMADA COM RETRY
  // ===========================

  let currentDelay = initialDelay;
  let retryCount = 0;
  let lastError = null;

  while (retryCount <= maxRetries) {
    try {
      // ===========================
      // RATE LIMITING
      // ===========================
      
      const waitTime = await withSupabaseRateLimit(async () => {
        // Rate limiting específico do endpoint
        return await rateLimiterManager.waitForSupabase(endpoint);
      }, endpoint);

      if (waitTime > 0) {
        logger.debug('Rate limit aplicado', { 
          waitTime: `${waitTime}ms`,
          endpoint 
        });
      }

      // ===========================
      // EXECUÇÃO DA REQUISIÇÃO
      // ===========================

      const startTime = Date.now();
      
      // Log da requisição (sanitizado)
      logHttpRequest(url, 'POST', sanitizeData(finalPayload), {
        empresa_id: Number(empresa_id),
        endpoint,
        attempt: retryCount + 1
      });

      const response = await Promise.race([
        fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(finalPayload)
        }),
        createTimeoutPromise(timeout)
      ]);

      const responseTime = Date.now() - startTime;

      // ===========================
      // PROCESSAMENTO DA RESPOSTA
      // ===========================

      // Log da resposta
      logHttpResponse(url, response.status, responseTime, {
        empresa_id: Number(empresa_id),
        endpoint,
        attempt: retryCount + 1
      });

      if (!response.ok) {
        const errorText = await response.text();
        const error = new Error(`Erro HTTP (${response.status}): ${errorText}`);
        error.status = response.status;
        error.responseTime = responseTime;
        
        // Verifica se deve fazer retry
        if (shouldRetry(response.status, retryCount, maxRetries, retryOnHttpCodes)) {
          lastError = error;
          await handleRetry(error, retryCount, currentDelay, logger, endpoint);
          retryCount++;
          currentDelay = Math.min(currentDelay * backoffFactor, 60000);
          continue;
        }
        
        throw error;
      }

      // ===========================
      // SUCESSO
      // ===========================

      const result = await response.json();
      
      // Registra sucesso no rate limiter
      rateLimiterManager.recordSuccess('supabase', endpoint);
      
      logger.info('Edge Function executada com sucesso', {
        endpoint,
        responseTime: `${responseTime}ms`,
        attempt: retryCount + 1,
        dataSize: JSON.stringify(result).length
      });

      return result;

    } catch (error) {
      lastError = error;
      
      // Log do erro
      logError(error, 'callEdgeFunction', {
        empresa_id: Number(empresa_id),
        endpoint,
        attempt: retryCount + 1,
        url: sanitizeUrl(url)
      });

      // Registra erro no rate limiter
      rateLimiterManager.recordError('supabase', error, endpoint);

      // Verifica se deve fazer retry
      const statusCode = error.status || 500;
      if (shouldRetry(statusCode, retryCount, maxRetries, retryOnHttpCodes)) {
        await handleRetry(error, retryCount, currentDelay, logger, endpoint);
        retryCount++;
        currentDelay = Math.min(currentDelay * backoffFactor, 60000);
        continue;
      }

      // Se chegou aqui, não deve fazer mais retry
      logger.error('Edge Function falhou após todas as tentativas', {
        endpoint,
        totalAttempts: retryCount + 1,
        finalError: error.message
      });

      throw lastError;
    }
  }

  // Nunca deveria chegar aqui, mas por segurança
  throw lastError || new Error('Edge Function falhou por motivo desconhecido');
}

// ===========================
// FUNÇÕES AUXILIARES
// ===========================

/**
 * Extrai nome do endpoint da URL para rate limiting específico
 */
function extractEndpoint(url) {
  try {
    const matches = url.match(/\/functions\/v1\/([^\/\?]+)/);
    return matches ? matches[1] : 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Sanitiza URL para logging (remove dados sensíveis)
 */
function sanitizeUrl(url) {
  return url.replace(/\/functions\/v1\/[^\/]+/, '/functions/v1/***');
}

/**
 * Verifica se deve fazer retry baseado no status e configurações
 */
function shouldRetry(statusCode, currentRetry, maxRetries, retryOnHttpCodes) {
  if (currentRetry >= maxRetries) return false;
  
  // Timeout errors sempre fazem retry
  const isTimeoutError = statusCode === 408 || statusCode === 504;
  if (isTimeoutError) return true;
  
  // Verifica se o código está na lista de códigos para retry
  return retryOnHttpCodes.includes(statusCode);
}

/**
 * Trata lógica de retry com logging
 * CORREÇÃO: Renomeado o parâmetro 'delay' para 'delayTime' para evitar conflito
 */
async function handleRetry(error, retryCount, delayTime, logger, endpoint) {
  const isTimeoutError = 
    (error.status === 500 || error.status === 503 || error.status === 504) && 
    (error.message?.includes('timeout') || error.message?.includes('cancelling statement'));

  logger.warn('Tentativa falhada, fazendo retry', {
    endpoint,
    attempt: retryCount + 1,
    error: error.message,
    isTimeout: isTimeoutError,
    nextRetryIn: `${delayTime}ms`
  });

  // Registra retry no rate limiter para estatísticas
  rateLimiterManager.recordError('supabase', error, endpoint);

  // Usa a função delay importada corretamente
  await delay(delayTime);
}

/**
 * Cria promise que rejeita após timeout
 */
function createTimeoutPromise(timeoutMs) {
  return new Promise((_, reject) => {
    setTimeout(() => {
      reject(new Error(`Request timeout after ${timeoutMs}ms`));
    }, timeoutMs);
  });
}

// ===========================
// VERSÕES CONVENIENTES
// ===========================

/**
 * Versão simplificada para casos comuns
 */
async function callEdgeFunctionSimple(url, payload, empresa_id, accessToken, refresh_token) {
  return callEdgeFunction(url, payload, empresa_id, accessToken, refresh_token, {
    context: 'default'
  });
}

/**
 * Versão para operações críticas (mais tentativas)
 */
async function callEdgeFunctionCritical(url, payload, empresa_id, accessToken, refresh_token) {
  return callEdgeFunction(url, payload, empresa_id, accessToken, refresh_token, {
    context: 'default',
    maxRetries: 30,
    initialDelay: 3000
  });
}

/**
 * Versão para notas fiscais (menos agressivo)
 */
async function callEdgeFunctionNotes(url, payload, empresa_id, accessToken, refresh_token) {
  return callEdgeFunction(url, payload, empresa_id, accessToken, refresh_token, {
    context: 'notes'
  });
}

/**
 * Versão para APIs externas
 */
async function callEdgeFunctionExternal(url, payload, empresa_id, accessToken, refresh_token) {
  return callEdgeFunction(url, payload, empresa_id, accessToken, refresh_token, {
    context: 'external'
  });
}

// ===========================
// EXPORTAÇÕES
// ===========================

module.exports = {
  // Função principal
  callEdgeFunction,
  
  // Versões convenientes
  callEdgeFunctionSimple,
  callEdgeFunctionCritical,
  callEdgeFunctionNotes,
  callEdgeFunctionExternal,
  
  // Utilitários (para testes)
  extractEndpoint,
  sanitizeUrl,
  shouldRetry
};