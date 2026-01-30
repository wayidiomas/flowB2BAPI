// src/utils/rateLimiter.js
const { RATE_LIMIT } = require('../config/SyncConfig');
const { logger } = require('./logger');
const delay = require('./delay');

/**
 * Sistema de Rate Limiting inteligente para diferentes APIs
 * Controla velocidade de requisições para respeitar limites das APIs
 */

// ===========================
// CLASSE BASE DE RATE LIMITER
// ===========================

class RateLimiter {
  constructor(name, requestsPerMinute, requestsPerHour = null) {
    this.name = name;
    this.requestsPerMinute = requestsPerMinute;
    this.requestsPerHour = requestsPerHour;
    
    // Janelas deslizantes para controle
    this.minuteWindow = [];
    this.hourWindow = [];
    
    // Estatísticas
    this.stats = {
      totalRequests: 0,
      rejectedRequests: 0,
      waitTime: 0,
      lastRequest: null,
      avgWaitTime: 0
    };
    
    // Configurações adaptativas
    this.adaptive = {
      enabled: true,
      consecutiveErrors: 0,
      slowdownFactor: 1,
      maxSlowdownFactor: 3,
      recoveryTime: 60000 // 1 minuto para recuperação
    };
    
    logger.debug(`🚦 Rate Limiter criado: ${name}`, {
      service: 'rate-limiter',
      requestsPerMinute,
      requestsPerHour
    });
  }

  /**
   * Verifica se pode fazer requisição e aguarda se necessário
   */
  async waitIfNeeded() {
    const now = Date.now();
    
    // Remove requisições antigas das janelas
    this.cleanWindows(now);
    
    // Verifica limites
    const minuteLimit = Math.floor(this.requestsPerMinute / this.adaptive.slowdownFactor);
    const hourLimit = this.requestsPerHour ? Math.floor(this.requestsPerHour / this.adaptive.slowdownFactor) : null;
    
    // Calcula tempo de espera necessário
    const waitTime = this.calculateWaitTime(now, minuteLimit, hourLimit);
    
    if (waitTime > 0) {
      this.stats.waitTime += waitTime;
      this.updateAvgWaitTime();
      
      logger.debug(`⏱️ Rate limit: aguardando ${waitTime}ms`, {
        service: 'rate-limiter',
        limiter: this.name,
        waitTime: `${waitTime}ms`,
        currentRequests: this.minuteWindow.length,
        limit: minuteLimit
      });
      
      await delay(waitTime);
    }
    
    // Registra a requisição
    this.recordRequest(now);
    
    return waitTime;
  }

  /**
   * Remove requisições antigas das janelas deslizantes
   */
  cleanWindows(now) {
    const oneMinuteAgo = now - 60000;
    const oneHourAgo = now - 3600000;
    
    // Limpa janela de minuto
    this.minuteWindow = this.minuteWindow.filter(time => time > oneMinuteAgo);
    
    // Limpa janela de hora
    if (this.requestsPerHour) {
      this.hourWindow = this.hourWindow.filter(time => time > oneHourAgo);
    }
  }

  /**
   * Calcula tempo de espera necessário
   */
  calculateWaitTime(now, minuteLimit, hourLimit) {
    let waitTime = 0;
    
    // Verifica limite por minuto
    if (this.minuteWindow.length >= minuteLimit) {
      const oldestRequest = this.minuteWindow[0];
      const minuteWait = 60000 - (now - oldestRequest);
      waitTime = Math.max(waitTime, minuteWait);
    }
    
    // Verifica limite por hora
    if (hourLimit && this.hourWindow.length >= hourLimit) {
      const oldestRequest = this.hourWindow[0];
      const hourWait = 3600000 - (now - oldestRequest);
      waitTime = Math.max(waitTime, hourWait);
    }
    
    return Math.max(waitTime, 0);
  }

  /**
   * Registra uma nova requisição
   */
  recordRequest(timestamp = Date.now()) {
    this.minuteWindow.push(timestamp);
    
    if (this.requestsPerHour) {
      this.hourWindow.push(timestamp);
    }
    
    this.stats.totalRequests++;
    this.stats.lastRequest = new Date(timestamp).toISOString();
  }

  /**
   * Registra erro para rate limiting adaptativo
   */
  recordError(error) {
    this.adaptive.consecutiveErrors++;
    
    // Aumenta o slowdown após múltiplos erros
    if (this.adaptive.consecutiveErrors >= 3) {
      this.adaptive.slowdownFactor = Math.min(
        this.adaptive.slowdownFactor * 1.5,
        this.adaptive.maxSlowdownFactor
      );
      
      logger.warn(`🐌 Rate limiter adaptativo: slowdown aumentado`, {
        service: 'rate-limiter',
        limiter: this.name,
        consecutiveErrors: this.adaptive.consecutiveErrors,
        slowdownFactor: this.adaptive.slowdownFactor
      });
    }
  }

  /**
   * Registra sucesso para recovery adaptativo
   */
  recordSuccess() {
    if (this.adaptive.consecutiveErrors > 0) {
      this.adaptive.consecutiveErrors = Math.max(this.adaptive.consecutiveErrors - 1, 0);
      
      // Recupera gradualmente se não houver erros
      if (this.adaptive.consecutiveErrors === 0 && this.adaptive.slowdownFactor > 1) {
        this.adaptive.slowdownFactor = Math.max(this.adaptive.slowdownFactor * 0.9, 1);
        
        logger.info(`🚀 Rate limiter recuperado`, {
          service: 'rate-limiter',
          limiter: this.name,
          slowdownFactor: this.adaptive.slowdownFactor
        });
      }
    }
  }

  /**
   * Atualiza tempo médio de espera
   */
  updateAvgWaitTime() {
    if (this.stats.totalRequests > 0) {
      this.stats.avgWaitTime = this.stats.waitTime / this.stats.totalRequests;
    }
  }

  /**
   * Obtém estatísticas do rate limiter
   */
  getStats() {
    const now = Date.now();
    this.cleanWindows(now);
    
    return {
      name: this.name,
      limits: {
        requestsPerMinute: this.requestsPerMinute,
        requestsPerHour: this.requestsPerHour,
        effectiveRpmLimit: Math.floor(this.requestsPerMinute / this.adaptive.slowdownFactor)
      },
      current: {
        requestsInLastMinute: this.minuteWindow.length,
        requestsInLastHour: this.hourWindow.length,
        slowdownFactor: this.adaptive.slowdownFactor,
        consecutiveErrors: this.adaptive.consecutiveErrors
      },
      stats: {
        ...this.stats,
        avgWaitTime: Math.round(this.stats.avgWaitTime)
      },
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Reset das estatísticas
   */
  reset() {
    this.stats = {
      totalRequests: 0,
      rejectedRequests: 0,
      waitTime: 0,
      lastRequest: null,
      avgWaitTime: 0
    };
    
    this.adaptive.consecutiveErrors = 0;
    this.adaptive.slowdownFactor = 1;
    
    logger.info(`🔄 Rate limiter resetado: ${this.name}`, {
      service: 'rate-limiter'
    });
  }
}

// ===========================
// RATE LIMITER PARA TOKENS
// ===========================

class TokenRateLimiter extends RateLimiter {
  constructor() {
    super('bling-token', 10, 100); // 10/min, 100/hora para renovação de tokens
    this.renewalQueue = new Map(); // empresa_id -> Promise
  }

  /**
   * Rate limiting específico para renovação de tokens
   */
  async waitForTokenRenewal(empresa_id) {
    // Se já há uma renovação em andamento, aguarda
    if (this.renewalQueue.has(empresa_id)) {
      logger.debug(`⏳ Aguardando renovação de token em progresso`, {
        service: 'rate-limiter',
        empresa_id
      });
      
      return await this.renewalQueue.get(empresa_id);
    }
    
    // Aguarda rate limit normal
    await this.waitIfNeeded();
    
    return true;
  }

  /**
   * Registra início de renovação de token
   */
  startTokenRenewal(empresa_id, renewalPromise) {
    // Silencia rejeição para evitar unhandledRejection crash
    const silentPromise = renewalPromise.catch(() => {});
    this.renewalQueue.set(empresa_id, silentPromise);

    // Remove da queue quando completar
    silentPromise.finally(() => {
      this.renewalQueue.delete(empresa_id);
    });
  }
}

// ===========================
// RATE LIMITER PARA EDGE FUNCTIONS
// ===========================

class EdgeFunctionRateLimiter extends RateLimiter {
  constructor() {
    super('supabase-edge', RATE_LIMIT.SUPABASE_REQUESTS_PER_MINUTE);
    this.endpointLimiters = new Map(); // endpoint -> mini rate limiter
  }

  /**
   * Rate limiting por endpoint específico
   */
  async waitForEndpoint(endpoint, requestsPerMinute = 60) {
    // Rate limit global primeiro
    await this.waitIfNeeded();
    
    // Rate limit específico do endpoint
    if (!this.endpointLimiters.has(endpoint)) {
      this.endpointLimiters.set(endpoint, new RateLimiter(
        `endpoint-${endpoint}`,
        requestsPerMinute
      ));
    }
    
    const endpointLimiter = this.endpointLimiters.get(endpoint);
    return await endpointLimiter.waitIfNeeded();
  }

  /**
   * Registra resultado de requisição para endpoint
   */
  recordEndpointResult(endpoint, success) {
    if (this.endpointLimiters.has(endpoint)) {
      const limiter = this.endpointLimiters.get(endpoint);
      if (success) {
        limiter.recordSuccess();
      } else {
        limiter.recordError(new Error('Request failed'));
      }
    }
  }

  /**
   * Obtém estatísticas de todos os endpoints
   */
  getAllStats() {
    const globalStats = this.getStats();
    const endpointStats = {};
    
    for (const [endpoint, limiter] of this.endpointLimiters.entries()) {
      endpointStats[endpoint] = limiter.getStats();
    }
    
    return {
      global: globalStats,
      endpoints: endpointStats
    };
  }
}

// ===========================
// GERENCIADOR GLOBAL DE RATE LIMITERS
// ===========================

class RateLimiterManager {
  constructor() {
    // Diferentes rate limiters para diferentes APIs
    this.limiters = {
      bling: new RateLimiter('bling-api', RATE_LIMIT.BLING_REQUESTS_PER_MINUTE, RATE_LIMIT.BLING_REQUESTS_PER_HOUR),
      supabase: new EdgeFunctionRateLimiter(),
      external: new RateLimiter('external-apis', RATE_LIMIT.EXTERNAL_REQUESTS_PER_MINUTE),
      token: new TokenRateLimiter()
    };
    
    logger.info(`🚦 Rate Limiter Manager inicializado`, {
      service: 'rate-limiter',
      limiters: Object.keys(this.limiters)
    });
  }

  /**
   * Obtém rate limiter específico
   */
  getLimiter(type) {
    return this.limiters[type];
  }

  /**
   * Rate limiting para API do Bling
   */
  async waitForBling() {
    return await this.limiters.bling.waitIfNeeded();
  }

  /**
   * Rate limiting para Supabase Edge Functions
   */
  async waitForSupabase(endpoint = null) {
    if (endpoint) {
      return await this.limiters.supabase.waitForEndpoint(endpoint);
    }
    return await this.limiters.supabase.waitIfNeeded();
  }

  /**
   * Rate limiting para APIs externas
   */
  async waitForExternal() {
    return await this.limiters.external.waitIfNeeded();
  }

  /**
   * Rate limiting para renovação de tokens
   */
  async waitForToken(empresa_id = null) {
    if (empresa_id) {
      return await this.limiters.token.waitForTokenRenewal(empresa_id);
    }
    return await this.limiters.token.waitIfNeeded();
  }

  /**
   * Registra sucesso de requisição
   */
  recordSuccess(type, endpoint = null) {
    const limiter = this.limiters[type];
    if (limiter) {
      limiter.recordSuccess();
      
      if (type === 'supabase' && endpoint) {
        limiter.recordEndpointResult(endpoint, true);
      }
    }
  }

  /**
   * Registra erro de requisição
   */
  recordError(type, error, endpoint = null) {
    const limiter = this.limiters[type];
    if (limiter) {
      limiter.recordError(error);
      
      if (type === 'supabase' && endpoint) {
        limiter.recordEndpointResult(endpoint, false);
      }
    }
  }

  /**
   * Registra início de renovação de token
   */
  startTokenRenewal(empresa_id, renewalPromise) {
    this.limiters.token.startTokenRenewal(empresa_id, renewalPromise);
  }

  /**
   * Obtém estatísticas de todos os rate limiters
   */
  getAllStats() {
    const stats = {};
    
    for (const [type, limiter] of Object.entries(this.limiters)) {
      if (type === 'supabase') {
        stats[type] = limiter.getAllStats();
      } else {
        stats[type] = limiter.getStats();
      }
    }
    
    return {
      timestamp: new Date().toISOString(),
      limiters: stats
    };
  }

  /**
   * Reset de todos os rate limiters
   */
  resetAll() {
    for (const limiter of Object.values(this.limiters)) {
      limiter.reset();
    }
    
    logger.info(`🔄 Todos os rate limiters resetados`, {
      service: 'rate-limiter'
    });
  }

  /**
   * Middleware Express para rate limiting de API
   */
  createExpressMiddleware(type = 'external', requestsPerMinute = 60) {
    const limiter = new RateLimiter(`express-${type}`, requestsPerMinute);
    
    return async (req, res, next) => {
      try {
        const waitTime = await limiter.waitIfNeeded();
        
        // Adiciona headers informativos
        res.set({
          'X-RateLimit-Limit': requestsPerMinute,
          'X-RateLimit-Remaining': Math.max(requestsPerMinute - limiter.minuteWindow.length, 0),
          'X-RateLimit-Reset': new Date(Date.now() + 60000).toISOString()
        });
        
        if (waitTime > 0) {
          res.set('X-RateLimit-Delay', waitTime);
        }
        
        next();
      } catch (error) {
        logger.error(`❌ Erro no rate limiting middleware`, {
          service: 'rate-limiter',
          error: error.message
        });
        
        res.status(429).json({
          error: 'Rate limit exceeded',
          message: 'Too many requests, please try again later'
        });
      }
    };
  }
}

// ===========================
// INSTÂNCIA SINGLETON
// ===========================

const rateLimiterManager = new RateLimiterManager();

// ===========================
// FUNÇÕES UTILITÁRIAS
// ===========================

/**
 * Wrapper para chamadas da API do Bling com rate limiting
 */
async function withBlingRateLimit(apiCall) {
  await rateLimiterManager.waitForBling();
  
  try {
    const result = await apiCall();
    rateLimiterManager.recordSuccess('bling');
    return result;
  } catch (error) {
    rateLimiterManager.recordError('bling', error);
    throw error;
  }
}

/**
 * Wrapper para chamadas do Supabase com rate limiting
 */
async function withSupabaseRateLimit(apiCall, endpoint = null) {
  await rateLimiterManager.waitForSupabase(endpoint);
  
  try {
    const result = await apiCall();
    rateLimiterManager.recordSuccess('supabase', endpoint);
    return result;
  } catch (error) {
    rateLimiterManager.recordError('supabase', error, endpoint);
    throw error;
  }
}

/**
 * Wrapper para APIs externas com rate limiting
 */
async function withExternalRateLimit(apiCall) {
  await rateLimiterManager.waitForExternal();
  
  try {
    const result = await apiCall();
    rateLimiterManager.recordSuccess('external');
    return result;
  } catch (error) {
    rateLimiterManager.recordError('external', error);
    throw error;
  }
}

// ===========================
// EXPORTAÇÕES
// ===========================

module.exports = {
  // Classes
  RateLimiter,
  TokenRateLimiter,
  EdgeFunctionRateLimiter,
  RateLimiterManager,
  
  // Instância singleton
  rateLimiterManager,
  
  // Wrappers convenientes
  withBlingRateLimit,
  withSupabaseRateLimit,
  withExternalRateLimit,
  
  // Funções diretas
  waitForBling: () => rateLimiterManager.waitForBling(),
  waitForSupabase: (endpoint) => rateLimiterManager.waitForSupabase(endpoint),
  waitForExternal: () => rateLimiterManager.waitForExternal(),
  waitForToken: (empresa_id) => rateLimiterManager.waitForToken(empresa_id),
  
  // Estatísticas e controle
  getRateLimitStats: () => rateLimiterManager.getAllStats(),
  resetRateLimiters: () => rateLimiterManager.resetAll(),
  
  // Middleware Express
  createRateLimitMiddleware: (type, rpm) => rateLimiterManager.createExpressMiddleware(type, rpm),
};