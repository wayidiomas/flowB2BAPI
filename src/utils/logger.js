// src/utils/logger.js
const winston = require('winston');
const path = require('path');
const { LOGGING, ENV } = require('../config/SyncConfig');

/**
 * Logger estruturado para o sistema de sincronização FlowB2B
 * Fornece logs estruturados com diferentes níveis e contextos
 */

// ===========================
// FORMATADORES CUSTOMIZADOS
// ===========================

/**
 * Formata logs para produção (JSON estruturado)
 */
const productionFormat = winston.format.combine(
  winston.format.timestamp({
    format: 'YYYY-MM-DD HH:mm:ss.SSS'
  }),
  winston.format.errors({ stack: true }),
  winston.format.json(),
  winston.format.printf(({ timestamp, level, message, service, operation, empresa_id, step, ...meta }) => {
    const logEntry = {
      timestamp,
      level: level.toUpperCase(),
      service: service || 'flowb2b-api',
      message,
      ...(operation && { operation }),
      ...(empresa_id && { empresa_id }),
      ...(step && { step }),
      ...meta
    };
    
    return JSON.stringify(logEntry);
  })
);

/**
 * Formata logs para desenvolvimento (mais legível)
 */
const developmentFormat = winston.format.combine(
  winston.format.timestamp({
    format: 'HH:mm:ss.SSS'
  }),
  winston.format.errors({ stack: true }),
  winston.format.colorize(),
  winston.format.printf(({ timestamp, level, message, service, operation, empresa_id, step, ...meta }) => {
    let logMessage = `${timestamp} [${level}]`;
    
    if (service) logMessage += ` [${service}]`;
    if (operation) logMessage += ` [${operation}]`;
    if (empresa_id) logMessage += ` [EMP:${empresa_id}]`;
    if (step) logMessage += ` [${step}]`;
    
    logMessage += `: ${message}`;
    
    // Adiciona metadados se existirem
    if (Object.keys(meta).length > 0) {
      logMessage += `\n${JSON.stringify(meta, null, 2)}`;
    }
    
    return logMessage;
  })
);

// ===========================
// CONFIGURAÇÃO DOS TRANSPORTS
// ===========================

const transports = [];

// Console transport (sempre presente)
transports.push(
  new winston.transports.Console({
    level: LOGGING.LEVEL,
    format: ENV.IS_PRODUCTION ? productionFormat : developmentFormat,
    handleExceptions: true,
    handleRejections: true
  })
);

// File transports (apenas em produção ou se especificado)
if (ENV.IS_PRODUCTION || process.env.LOG_TO_FILE === 'true') {
  const logDir = path.join(process.cwd(), 'logs');
  
  // Log geral
  transports.push(
    new winston.transports.File({
      filename: path.join(logDir, 'app.log'),
      level: 'info',
      format: productionFormat,
      maxsize: LOGGING.FILE.MAX_SIZE,
      maxFiles: LOGGING.FILE.MAX_FILES,
      tailable: true
    })
  );
  
  // Log de erros separado
  transports.push(
    new winston.transports.File({
      filename: path.join(logDir, 'error.log'),
      level: 'error',
      format: productionFormat,
      maxsize: LOGGING.FILE.MAX_SIZE,
      maxFiles: LOGGING.FILE.MAX_FILES,
      tailable: true
    })
  );
  
  // Log de sincronização separado
  transports.push(
    new winston.transports.File({
      filename: path.join(logDir, 'sync.log'),
      level: 'debug',
      format: productionFormat,
      maxsize: LOGGING.FILE.MAX_SIZE,
      maxFiles: LOGGING.FILE.MAX_FILES,
      tailable: true,
      // Filtro para logs relacionados à sincronização
      filter: (info) => {
        return info.service === 'sync' || 
               info.operation?.includes('sync') || 
               info.step !== undefined;
      }
    })
  );
}

// ===========================
// CRIAÇÃO DO LOGGER
// ===========================

const logger = winston.createLogger({
  level: LOGGING.LEVEL,
  transports,
  exitOnError: false,
  
  // Tratamento de exceções não capturadas
  exceptionHandlers: [
    new winston.transports.Console({
      format: ENV.IS_PRODUCTION ? productionFormat : developmentFormat
    })
  ],
  
  // Tratamento de promises rejeitadas
  rejectionHandlers: [
    new winston.transports.Console({
      format: ENV.IS_PRODUCTION ? productionFormat : developmentFormat
    })
  ]
});

// ===========================
// CLASSE DE CONTEXTO
// ===========================

/**
 * Classe para manter contexto entre logs relacionados
 */
class LogContext {
  constructor(baseContext = {}) {
    this.context = { ...baseContext };
  }
  
  /**
   * Adiciona contexto
   */
  setContext(key, value) {
    this.context[key] = value;
    return this;
  }
  
  /**
   * Remove contexto
   */
  removeContext(key) {
    delete this.context[key];
    return this;
  }
  
  /**
   * Cria um log com o contexto atual
   */
  log(level, message, meta = {}) {
    logger.log(level, message, { ...this.context, ...meta });
    return this;
  }
  
  info(message, meta = {}) { return this.log('info', message, meta); }
  warn(message, meta = {}) { return this.log('warn', message, meta); }
  error(message, meta = {}) { return this.log('error', message, meta); }
  debug(message, meta = {}) { return this.log('debug', message, meta); }
}

// ===========================
// FUNÇÕES UTILITÁRIAS
// ===========================

/**
 * Sanitiza dados sensíveis antes de logar
 */
function sanitizeData(data) {
  if (!data || typeof data !== 'object') return data;
  
  const sensitiveKeys = ['access_token', 'refresh_token', 'authorization', 'password', 'key', 'secret'];
  const sanitized = { ...data };
  
  for (const key of Object.keys(sanitized)) {
    if (sensitiveKeys.some(sensitive => key.toLowerCase().includes(sensitive))) {
      sanitized[key] = sanitized[key] ? `${sanitized[key].substring(0, 6)}***` : '***';
    }
  }
  
  return sanitized;
}

/**
 * Cria um contexto de log para sincronização
 */
function createSyncContext(empresa_id, operation, step = null) {
  const context = new LogContext({
    service: 'sync',
    empresa_id: Number(empresa_id),
    operation,
    ...(step && { step })
  });
  
  return context;
}

/**
 * Cria um contexto de log para API
 */
function createApiContext(endpoint, method = 'POST') {
  return new LogContext({
    service: 'api',
    endpoint,
    method
  });
}

/**
 * Cria um contexto de log para tokens
 */
function createTokenContext(empresa_id) {
  return new LogContext({
    service: 'token',
    empresa_id: Number(empresa_id)
  });
}

/**
 * Loga início de operação
 */
function logOperationStart(operation, context = {}) {
  logger.info(`🚀 Iniciando ${operation}`, {
    operation,
    status: 'started',
    timestamp: new Date().toISOString(),
    ...context
  });
}

/**
 * Loga fim de operação
 */
function logOperationEnd(operation, success = true, context = {}) {
  const emoji = success ? '✅' : '❌';
  const status = success ? 'completed' : 'failed';
  
  logger.info(`${emoji} ${operation} ${status}`, {
    operation,
    status,
    success,
    timestamp: new Date().toISOString(),
    ...context
  });
}

/**
 * Loga erro com contexto completo
 */
function logError(error, operation = null, context = {}) {
  const errorInfo = {
    message: error.message,
    stack: error.stack,
    name: error.name,
    ...(error.status && { status: error.status }),
    ...(error.code && { code: error.code }),
    ...(operation && { operation }),
    ...context
  };
  
  logger.error(`❌ Erro${operation ? ` em ${operation}` : ''}`, errorInfo);
}

/**
 * Loga requisição HTTP (sanitizada)
 */
function logHttpRequest(url, method, payload = null, context = {}) {
  if (!LOGGING.LOG_REQUESTS) return;
  
  const requestInfo = {
    url: url.replace(/\/functions\/v1\/[^\/]+/, '/functions/v1/***'), // Sanitiza URLs
    method,
    ...(payload && { payload: sanitizeData(payload) }),
    timestamp: new Date().toISOString(),
    ...context
  };
  
  logger.debug(`📤 HTTP Request: ${method} ${url}`, requestInfo);
}

/**
 * Loga resposta HTTP
 */
function logHttpResponse(url, status, responseTime = null, context = {}) {
  if (!LOGGING.LOG_REQUESTS) return;
  
  const responseInfo = {
    url: url.replace(/\/functions\/v1\/[^\/]+/, '/functions/v1/***'),
    status,
    ...(responseTime && { responseTime: `${responseTime}ms` }),
    timestamp: new Date().toISOString(),
    ...context
  };
  
  const emoji = status >= 200 && status < 300 ? '✅' : '❌';
  logger.debug(`${emoji} HTTP Response: ${status}`, responseInfo);
}

/**
 * Loga métricas de performance
 */
function logPerformanceMetrics(operation, metrics, context = {}) {
  if (!LOGGING.LOG_PERFORMANCE) return;
  
  logger.info(`📊 Performance: ${operation}`, {
    operation,
    metrics: {
      ...metrics,
      timestamp: new Date().toISOString()
    },
    ...context
  });
}

/**
 * Loga progresso de paginação
 */
function logPaginationProgress(currentPage, totalProcessed, operation, context = {}) {
  logger.info(`📄 Página ${currentPage} processada`, {
    operation,
    currentPage,
    totalProcessed,
    timestamp: new Date().toISOString(),
    ...context
  });
}

/**
 * Middleware para Express que loga requests
 */
function requestLogger(req, res, next) {
  const start = Date.now();
  const { method, url, ip } = req;
  
  // Log da requisição
  logger.info(`📥 ${method} ${url}`, {
    service: 'api',
    method,
    url,
    ip,
    userAgent: req.get('User-Agent'),
    timestamp: new Date().toISOString()
  });
  
  // Intercepta o fim da resposta
  const originalSend = res.send;
  res.send = function(...args) {
    const responseTime = Date.now() - start;
    
    logger.info(`📤 ${method} ${url} - ${res.statusCode}`, {
      service: 'api',
      method,
      url,
      statusCode: res.statusCode,
      responseTime: `${responseTime}ms`,
      timestamp: new Date().toISOString()
    });
    
    return originalSend.apply(this, args);
  };
  
  next();
}

// ===========================
// EXPORTAÇÕES
// ===========================

module.exports = {
  // Logger principal
  logger,
  
  // Classes utilitárias
  LogContext,
  
  // Criadores de contexto
  createSyncContext,
  createApiContext,
  createTokenContext,
  
  // Funções de log estruturado
  logOperationStart,
  logOperationEnd,
  logError,
  logHttpRequest,
  logHttpResponse,
  logPerformanceMetrics,
  logPaginationProgress,
  
  // Utilitários
  sanitizeData,
  requestLogger,
  
  // Métodos diretos do logger (para compatibilidade)
  info: (message, meta) => logger.info(message, meta),
  warn: (message, meta) => logger.warn(message, meta),
  error: (message, meta) => logger.error(message, meta),
  debug: (message, meta) => logger.debug(message, meta),
};