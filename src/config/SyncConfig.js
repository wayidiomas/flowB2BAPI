// src/config/syncConfig.js
require("dotenv").config();

/**
 * Configurações centralizadas para o sistema de sincronização
 * Todas as configurações de delays, retry, paginação e limites estão aqui
 */

const SYNC_CONFIG = {
  // ===========================
  // DELAYS (em milissegundos)
  // ===========================
  DELAYS: {
    // Delays entre páginas durante paginação
    BETWEEN_PAGES: 50000,           // 50 segundos entre páginas
    BETWEEN_PAGES_INVENTORY: 10000, // 10 segundos para estoque (mais rápido)
    BETWEEN_PAGES_NOTES: 5000,      // 5 segundos para notas fiscais
    
    // Delays entre etapas/steps
    BETWEEN_STEPS: 80000,           // 80 segundos entre etapas principais
    BETWEEN_MINI_STEPS: 10000,      // 10 segundos entre sub-etapas
    BETWEEN_SUPPLIERS: 5000,        // 5 segundos entre fornecedores
    BETWEEN_DAYS: 5000,             // 5 segundos entre dias (loop diário)
    BETWEEN_MONTHS: 20000,          // 20 segundos entre meses
    
    // Delays especiais
    AFTER_LAST_REQUEST: 50000,      // 50 segundos após última requisição
    NOTES_BATCH_PAUSE: 15000,       // 15 segundos a cada 10 notas fiscais
    NOTES_INDIVIDUAL: 500,          // 500ms entre notas individuais
  },

  // ===========================
  // CONFIGURAÇÕES DE RETRY
  // ===========================
  RETRY: {
    // Configurações padrão para edge functions
    DEFAULT: {
      maxRetries: 20,
      initialDelay: 2000,           // 2 segundos inicial
      backoffFactor: 1.5,
      retryOnHttpCodes: [408, 429, 500, 502, 503, 504],
    },
    
    // Configurações para token service
    TOKEN_SERVICE: {
      maxRetries: 3,
      initialDelay: 1000,           // 1 segundo inicial
      backoffFactor: 1.5,
      retryOnHttpCodes: [401, 403, 429, 500, 502, 503, 504],
    },
    
    // Configurações para notas fiscais (menos agressivo)
    NOTES: {
      maxRetries: 5,
      initialDelay: 1000,
      backoffFactor: 1.2,
      retryOnHttpCodes: [500, 502, 503, 504],
    },
    
    // Configurações para validação EAN (externo)
    EXTERNAL_API: {
      maxRetries: 3,
      initialDelay: 2000,
      backoffFactor: 2.0,
      retryOnHttpCodes: [429, 500, 502, 503, 504],
    },
  },

  // ===========================
  // CONFIGURAÇÕES DE PAGINAÇÃO
  // ===========================
  PAGINATION: {
    DEFAULT_PAGE_SIZE: 100,
    DEFAULT_START_PAGE: 1,
    
    // Configurações específicas por endpoint
    PRODUCTS: {
      pageSize: 100,
      useQuantityControl: true,      // Para produtos, usa quantidade < 100 para parar
    },
    
    SUPPLIERS: {
      pageSize: 100,
      useQuantityControl: false,     // Para fornecedores, usa next_page
    },
    
    INVENTORY: {
      pageSize: 100,
      useQuantityControl: false,
    },
    
    NOTES: {
      pageSize: 50,                  // Menor para notas fiscais (mais pesadas)
      useQuantityControl: false,
    },
  },

  // ===========================
  // CONFIGURAÇÕES DE TOKEN
  // ===========================
  TOKEN: {
    RENEWAL_INTERVAL: 60 * 60 * 1000,        // 1 hora
    EXPIRATION_BUFFER: 10 * 60 * 1000,       // 10 minutos antes de expirar
    REQUEST_TIMEOUT: 30000,                   // 30 segundos timeout para requests
    
    // Headers padrão para requisições do Bling
    DEFAULT_HEADERS: {
      'Accept': '1.0',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
  },

  // ===========================
  // CONFIGURAÇÕES DE RATE LIMITING
  // ===========================
  RATE_LIMIT: {
    // Bling API limits (baseado na documentação)
    BLING_REQUESTS_PER_MINUTE: 300,          // 5 requests por segundo
    BLING_REQUESTS_PER_HOUR: 18000,          // Limite horário
    
    // Supabase Edge Functions
    SUPABASE_REQUESTS_PER_MINUTE: 600,       // Mais permissivo
    
    // APIs externas
    EXTERNAL_REQUESTS_PER_MINUTE: 60,        // Mais conservador
  },

  // ===========================
  // CONFIGURAÇÕES DE SINCRONIZAÇÃO
  // ===========================
  SYNC: {
    // Períodos de sincronização
    FIRST_TIME_PERIOD_MONTHS: 12,            // 1 ano para first-time
    DAILY_PERIOD_DAYS: 2,                    // 2 dias para daily (ontem e hoje)
    NOTES_PERIOD_MONTHS: 1,                  // 1 mês para notas fiscais
    
    // Batch sizes para processamento
    NOTES_BATCH_SIZE: 10,                    // Processa 10 notas por vez
    SUPPLIERS_BATCH_SIZE: 50,                // 50 fornecedores por lote
    
    // Timeouts para diferentes operações
    TIMEOUTS: {
      STEP_TIMEOUT: 10 * 60 * 1000,         // 10 minutos por step
      TOTAL_SYNC_TIMEOUT: 6 * 60 * 60 * 1000, // 6 horas total
      EDGE_FUNCTION_TIMEOUT: 5 * 60 * 1000,  // 5 minutos por edge function
    },
  },

  // ===========================
  // CONFIGURAÇÕES DE LOGGING
  // ===========================
  LOGGING: {
    LEVEL: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
    
    // Configurações de arquivo de log
    FILE: {
      MAX_SIZE: '100MB',
      MAX_FILES: 5,
      DATE_PATTERN: 'YYYY-MM-DD',
    },
    
    // Que tipos de dados logar
    LOG_TOKENS: false,                       // NUNCA logar tokens completos
    LOG_REQUESTS: true,                      // Logar requests (sem dados sensíveis)
    LOG_RESPONSES: false,                    // Não logar responses completas (muito verboso)
    LOG_ERRORS: true,                        // Sempre logar erros
    LOG_PERFORMANCE: true,                   // Logar métricas de performance
  },

  // ===========================
  // CONFIGURAÇÕES DE AMBIENTE
  // ===========================
  ENV: {
    IS_PRODUCTION: process.env.NODE_ENV === 'production',
    IS_DEVELOPMENT: process.env.NODE_ENV === 'development',
    IS_TEST: process.env.NODE_ENV === 'test',
    
    // URLs dos serviços
    SUPABASE_URL: process.env.SUPABASE_URL,
    VALIDACAO_EAN_URL: process.env.VALIDACAO_EAN_URL,
    WEBHOOK_URL: process.env.WEBHOOK_URL,
    WEBHOOK_URL_VINCULO: process.env.WEBHOOK_URL_VINCULO,
  },

  // ===========================
  // CONFIGURAÇÕES DE MONITORAMENTO
  // ===========================
  MONITORING: {
    // Métricas que devem ser coletadas
    COLLECT_METRICS: true,
    METRICS_INTERVAL: 30000,                 // Coleta métricas a cada 30 segundos
    
    // Alertas
    ERROR_THRESHOLD: 5,                      // Alerta após 5 erros consecutivos
    TIMEOUT_THRESHOLD: 3,                    // Alerta após 3 timeouts consecutivos
    
    // Health check
    HEALTH_CHECK_INTERVAL: 60000,            // 1 minuto
  },

  // ===========================
  // CONFIGURAÇÕES DE CORS
  // ===========================
  CORS: {
    // Origens permitidas (pode ser sobrescrito por ALLOWED_ORIGINS no .env)
    ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS 
      ? process.env.ALLOWED_ORIGINS.split(',').map(origin => origin.trim())
      : ['*'], // Padrão atual (muito permissivo)
    
    ALLOWED_METHODS: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    ALLOWED_HEADERS: ['Content-Type', 'Authorization'],
    CREDENTIALS: false,
    OPTIONS_SUCCESS_STATUS: 204,
  },
};

// ===========================
// FUNÇÕES UTILITÁRIAS
// ===========================

/**
 * Obtém configuração de delay baseada no contexto
 */
function getDelay(context, operation = 'default') {
  const delays = SYNC_CONFIG.DELAYS;
  
  switch (context) {
    case 'pagination':
      switch (operation) {
        case 'inventory': return delays.BETWEEN_PAGES_INVENTORY;
        case 'notes': return delays.BETWEEN_PAGES_NOTES;
        default: return delays.BETWEEN_PAGES;
      }
    case 'steps':
      return operation === 'mini' ? delays.BETWEEN_MINI_STEPS : delays.BETWEEN_STEPS;
    case 'suppliers':
      return delays.BETWEEN_SUPPLIERS;
    case 'days':
      return delays.BETWEEN_DAYS;
    case 'months':
      return delays.BETWEEN_MONTHS;
    default:
      return delays.BETWEEN_PAGES;
  }
}

/**
 * Obtém configuração de retry baseada no contexto
 */
function getRetryConfig(context = 'default') {
  const retryConfigs = SYNC_CONFIG.RETRY;
  
  switch (context) {
    case 'token': return retryConfigs.TOKEN_SERVICE;
    case 'notes': return retryConfigs.NOTES;
    case 'external': return retryConfigs.EXTERNAL_API;
    default: return retryConfigs.DEFAULT;
  }
}

/**
 * Obtém configuração de paginação baseada no endpoint
 */
function getPaginationConfig(endpoint) {
  const paginationConfigs = SYNC_CONFIG.PAGINATION;
  
  switch (endpoint) {
    case 'products': return paginationConfigs.PRODUCTS;
    case 'suppliers': return paginationConfigs.SUPPLIERS;
    case 'inventory': return paginationConfigs.INVENTORY;
    case 'notes': return paginationConfigs.NOTES;
    default: return {
      pageSize: paginationConfigs.DEFAULT_PAGE_SIZE,
      useQuantityControl: false,
    };
  }
}

/**
 * Verifica se está em ambiente de produção
 */
function isProduction() {
  return SYNC_CONFIG.ENV.IS_PRODUCTION;
}

/**
 * Obtém timeout baseado na operação
 */
function getTimeout(operation = 'default') {
  const timeouts = SYNC_CONFIG.SYNC.TIMEOUTS;
  
  switch (operation) {
    case 'step': return timeouts.STEP_TIMEOUT;
    case 'total': return timeouts.TOTAL_SYNC_TIMEOUT;
    case 'edge_function': return timeouts.EDGE_FUNCTION_TIMEOUT;
    default: return timeouts.EDGE_FUNCTION_TIMEOUT;
  }
}

// ===========================
// EXPORTAÇÕES
// ===========================

module.exports = {
  SYNC_CONFIG,
  
  // Funções utilitárias
  getDelay,
  getRetryConfig,
  getPaginationConfig,
  isProduction,
  getTimeout,
  
  // Exports diretos para facilitar importação
  DELAYS: SYNC_CONFIG.DELAYS,
  RETRY: SYNC_CONFIG.RETRY,
  PAGINATION: SYNC_CONFIG.PAGINATION,
  TOKEN: SYNC_CONFIG.TOKEN,
  RATE_LIMIT: SYNC_CONFIG.RATE_LIMIT,
  SYNC: SYNC_CONFIG.SYNC,
  LOGGING: SYNC_CONFIG.LOGGING,
  ENV: SYNC_CONFIG.ENV,
  MONITORING: SYNC_CONFIG.MONITORING,
  CORS: SYNC_CONFIG.CORS,
};