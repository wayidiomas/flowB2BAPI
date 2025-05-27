// src/services/retryService.js
const { refreshBlingToken } = require("./blingTokenService");
const delay = require("../utils/delay");

/**
 * Função genérica para reexecutar uma função em caso de erro 4XX ou 5XX.
 * @param {Function} func - Função a ser executada.
 * @param {number} empresa_id - ID da empresa.
 * @param {string} accessToken - Token de acesso atual.
 * @param {string} refresh_token - Token de atualização.
 * @param {Array} args - Argumentos adicionais a serem passados para a função.
 * @param {Object} options - Opções de retry (maxRetries, initialDelay, backoffFactor)
 */
async function executeWithRetry(func, empresa_id, accessToken, refresh_token, ...args) {
    try {
        return await func(accessToken, ...args);
    } catch (error) {
        // Detecta erros HTTP 4XX e 5XX, tanto em error.response quanto no próprio error
        const statusCode = error.response?.status || error.status;
        const isHttpError = statusCode >= 400 && statusCode < 600;
        
        // Verifica se é um erro de timeout
        const isTimeoutError = 
            (statusCode === 500 || statusCode === 503 || statusCode === 504) && 
            ((error.message?.includes('timeout') || error.message?.includes('cancelling statement')) ||
             (error.response?.data?.message?.includes('timeout')));

        if (isHttpError) {
            console.log(`🔁 Erro ${statusCode} detectado. Tentando atualizar o token...`);

            try {
                const newToken = await refreshBlingToken(empresa_id, refresh_token);
                console.log(`✅ Token atualizado com sucesso. Reexecutando a função...`);
                return await func(newToken.access_token, ...args);
            } catch (tokenError) {
                console.error(`❌ Erro ao atualizar o token:`, tokenError.message || tokenError);
                throw tokenError;
            }
        } else {
            console.error(`❌ Erro inesperado durante a execução da função:`, error.message || error);
            throw error;
        }
    }
}

/**
 * Função avançada para reexecutar uma função com múltiplas tentativas e backoff exponencial
 * @param {Function} func - Função a ser executada.
 * @param {number} empresa_id - ID da empresa.
 * @param {string} accessToken - Token de acesso atual.
 * @param {string} refresh_token - Token de atualização.
 * @param {Object} options - Opções de retry
 * @param {Array} args - Argumentos adicionais a serem passados para a função.
 */
async function executeWithAdvancedRetry(func, empresa_id, accessToken, refresh_token, options = {}, ...args) {
    const { 
        maxRetries = 20, 
        initialDelay = 1000, 
        backoffFactor = 1.5,
        retryOnHttpCodes = [408, 429, 500, 502, 503, 504],
        retryOnTimeoutOnly = false
    } = options;
    
    let currentDelay = initialDelay;
    let retryCount = 0;
    let currentToken = accessToken;
    let tokenRefreshed = false;
    
    while (retryCount < maxRetries) {
        try {
            return await func(currentToken, ...args);
        } catch (error) {
            retryCount++;
            
            // Detecta códigos de status HTTP
            const statusCode = error.response?.status || error.status;
            
            // Verifica se é um erro de timeout
            const isTimeoutError = 
                (statusCode === 500 || statusCode === 503 || statusCode === 504) && 
                ((error.message?.includes('timeout') || error.message?.includes('cancelling statement')) ||
                 (error.response?.data?.message?.includes('timeout')));
            
            // Determina se devemos fazer retry
            const shouldRetry = retryOnTimeoutOnly 
                ? isTimeoutError 
                : (retryOnHttpCodes.includes(statusCode) || isTimeoutError);
            
            // Se for o último retry ou não for um erro que justifique retry, propaga o erro
            if (retryCount >= maxRetries || !shouldRetry) {
                console.error(`❌ Falha após ${retryCount} tentativas:`, error.message || error);
                throw error;
            }
            
            console.log(`🔁 Tentativa ${retryCount}/${maxRetries} falhou. Código: ${statusCode}. Erro: ${error.message}`);
            
            // Tenta atualizar o token se ainda não foi atualizado e é um erro de autenticação
            if (!tokenRefreshed && (statusCode === 401 || statusCode === 403)) {
                try {
                    console.log(`🔑 Atualizando token antes da próxima tentativa...`);
                    const newToken = await refreshBlingToken(empresa_id, refresh_token);
                    currentToken = newToken.access_token;
                    tokenRefreshed = true;
                    console.log(`✅ Token atualizado com sucesso para a próxima tentativa.`);
                } catch (tokenError) {
                    console.error(`❌ Erro ao atualizar o token:`, tokenError.message || tokenError);
                    // Continuamos com o token atual
                }
            }
            
            // Espera pelo delay atual antes de tentar novamente
            console.log(`⏱️ Aguardando ${currentDelay}ms antes da próxima tentativa...`);
            await delay(currentDelay);
            
            // Aumenta o delay para a próxima tentativa (exponential backoff)
            currentDelay = Math.min(currentDelay * backoffFactor, 60000); // Máximo de 60 segundos
        }
    }
    
    // Este ponto só será alcançado se algo estiver errado na lógica de retry
    throw new Error(`Falha após ${maxRetries} tentativas. Algo está errado com a lógica de retry.`);
}

module.exports = {
    executeWithRetry,
    executeWithAdvancedRetry
};