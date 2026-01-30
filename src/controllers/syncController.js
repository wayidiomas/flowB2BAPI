// src/controllers/syncController.js
const syncService = require("../services/syncService");
const supabase = require("../services/supabaseService");
const {
  createApiContext,
  logError,
  logOperationStart,
  logOperationEnd,
  sanitizeData
} = require("../utils/logger");

/**
 * Classe para validação e sanitização de parâmetros
 */
class SyncRequestValidator {
  static validateCommonParams(req) {
    const { empresa_id, accessToken, refresh_token } = req.body;
    const errors = [];

    if (!empresa_id) {
      errors.push("empresa_id é obrigatório");
    } else if (!Number.isInteger(Number(empresa_id)) || Number(empresa_id) <= 0) {
      errors.push("empresa_id deve ser um número inteiro positivo");
    }

    if (!accessToken || typeof accessToken !== 'string') {
      errors.push("accessToken é obrigatório e deve ser uma string");
    }

    if (!refresh_token || typeof refresh_token !== 'string') {
      errors.push("refresh_token é obrigatório e deve ser uma string");
    }

    return {
      isValid: errors.length === 0,
      errors,
      params: {
        empresa_id: Number(empresa_id),
        accessToken,
        refresh_token
      }
    };
  }

  static validateFirstTimeParams(req) {
    const baseValidation = this.validateCommonParams(req);
    
    if (!baseValidation.isValid) {
      return baseValidation;
    }

    const { paginaAtual = 1 } = req.body;
    
    if (paginaAtual && (!Number.isInteger(Number(paginaAtual)) || Number(paginaAtual) < 1)) {
      baseValidation.errors.push("paginaAtual deve ser um número inteiro maior que 0");
      baseValidation.isValid = false;
    }

    baseValidation.params.paginaAtual = Number(paginaAtual);
    
    return baseValidation;
  }

  static validateFirstTimeFromStepParams(req) {
    const baseValidation = this.validateFirstTimeParams(req);
    
    if (!baseValidation.isValid) {
      return baseValidation;
    }

    const { startFromStep } = req.body;
    const validSteps = ['produtos', 'fornecedores', 'pedidos-venda', 'pedidos-compra', 'notas-fiscais'];
    
    if (!startFromStep) {
      baseValidation.errors.push("startFromStep é obrigatório");
      baseValidation.isValid = false;
    } else if (!validSteps.includes(startFromStep)) {
      baseValidation.errors.push(`startFromStep deve ser um dos valores: ${validSteps.join(', ')}`);
      baseValidation.isValid = false;
    }

    baseValidation.params.startFromStep = startFromStep;
    
    return baseValidation;
  }

  /**
   * Calcula quais etapas serão puladas
   */
  static getSkippedSteps(startFromStep) {
    const allSteps = ['produtos', 'fornecedores', 'pedidos-venda', 'pedidos-compra', 'notas-fiscais'];
    const startIndex = allSteps.indexOf(startFromStep);
    
    if (startIndex === -1) return [];
    
    return allSteps.slice(0, startIndex);
  }

  /**
   * Calcula quais etapas serão executadas
   */
  static getRemainingSteps(startFromStep) {
    const allSteps = ['produtos', 'fornecedores', 'pedidos-venda', 'pedidos-compra', 'notas-fiscais'];
    const startIndex = allSteps.indexOf(startFromStep);
    
    if (startIndex === -1) return allSteps;
    
    return allSteps.slice(startIndex);
  }
}

/**
 * Classe para gerenciar respostas de sincronização
 */
class SyncResponseManager {
  static sendAcceptedResponse(res, syncType, empresa_id, additionalData = {}) {
    const response = {
      success: true,
      message: `Sincronização ${syncType} iniciada com sucesso. O processo está em execução em background.`,
      empresa_id: Number(empresa_id),
      timestamp: new Date().toISOString(),
      status: "accepted",
      ...additionalData
    };

    res.status(202).json(response);
  }

  static sendErrorResponse(res, statusCode, message, details = {}) {
    const response = {
      success: false,
      error: message,
      timestamp: new Date().toISOString(),
      ...details
    };

    res.status(statusCode).json(response);
  }

  static sendValidationError(res, errors) {
    this.sendErrorResponse(res, 400, "Parâmetros inválidos", {
      validationErrors: errors,
      requiredParameters: ["empresa_id", "accessToken", "refresh_token"]
    });
  }
}

/**
 * Executa sincronização em background com logging completo
 */
async function executeBackgroundSync(syncFunction, params, syncType) {
  const { empresa_id } = params;
  const logger = createApiContext(`${syncType}-sync`, 'POST')
    .setContext('empresa_id', empresa_id)
    .setContext('syncType', syncType);

  try {
    logger.info('Iniciando sincronização em background', {
      params: sanitizeData(params)
    });

    logOperationStart(`background-${syncType}`, { empresa_id });

    const result = await syncFunction(params);

    logOperationEnd(`background-${syncType}`, result.success, {
      empresa_id,
      result: sanitizeData(result)
    });

    if (result.success) {
      logger.info('Sincronização background concluída com sucesso', {
        duration: result.metrics?.duration,
        recordsProcessed: result.metrics?.summary?.recordsProcessed
      });
    } else {
      logger.error('Sincronização background falhou', {
        error: result.error,
        message: result.message
      });
    }

    return result;

  } catch (error) {
    logError(error, `background-${syncType}`, { empresa_id });
    
    logger.error('Erro inesperado na sincronização background', {
      error: error.message,
      stack: error.stack
    });

    return {
      success: false,
      error: error.message,
      message: `Erro inesperado na sincronização ${syncType}`
    };
  }
}

/**
 * Verifica se já existe sincronização do MESMO TIPO ativa para a empresa
 */
function checkActiveSyncConflict(empresa_id, syncType) {
  const allActiveSyncs = syncService.getAllActiveSyncs();
  
  // Procura sincronização ativa do mesmo tipo para a mesma empresa
  const existingSync = allActiveSyncs.activeSyncs.find(sync => 
    sync.empresa_id === Number(empresa_id) && 
    sync.syncType === syncType &&
    sync.status === 'running'
  );
  
  if (existingSync) {
    return {
      hasConflict: true,
      currentSync: {
        syncType: existingSync.syncType,
        operation: existingSync.operation,
        currentStep: existingSync.currentStep,
        startTime: existingSync.startTime
      }
    };
  }
  
  return { hasConflict: false };
}

// ===========================
// CONTROLLERS DE SINCRONIZAÇÃO
// ===========================

exports.syncFirstTime = async (req, res) => {
  const logger = createApiContext('sync-first-time', 'POST');
  
  try {
    // Validação de parâmetros
    const validation = SyncRequestValidator.validateFirstTimeParams(req);
    
    if (!validation.isValid) {
      logger.warn('Parâmetros inválidos recebidos', {
        errors: validation.errors,
        body: sanitizeData(req.body)
      });
      
      return SyncResponseManager.sendValidationError(res, validation.errors);
    }

    const { empresa_id, accessToken, refresh_token, paginaAtual } = validation.params;

    // Verifica conflito de sincronização
    const conflictCheck = checkActiveSyncConflict(empresa_id, 'first-time');
    
    if (conflictCheck.hasConflict) {
      logger.warn('Sincronização já em andamento', {
        empresa_id,
        currentSync: conflictCheck.currentSync
      });
      
      return SyncResponseManager.sendErrorResponse(res, 409, 
        "Já existe uma sincronização em andamento para esta empresa", {
          empresa_id,
          currentSync: conflictCheck.currentSync
        }
      );
    }

    logger.info('Iniciando sincronização first-time', {
      empresa_id,
      paginaAtual,
      ip: req.ip,
      userAgent: req.get('User-Agent')
    });

    // Responde imediatamente
    SyncResponseManager.sendAcceptedResponse(res, 'first-time', empresa_id, {
      paginaAtual,
      statusEndpoint: `/api/sync/status/${empresa_id}`,
      cancelEndpoint: `/api/sync/cancel/${empresa_id}/first-time`
    });

    // Processa em background
    setImmediate(async () => {
      await executeBackgroundSync(
        syncService.handleFirstTimeSync,
        { empresa_id, accessToken, refresh_token, paginaAtual },
        'first-time'
      );
    });

  } catch (error) {
    logError(error, 'syncFirstTime', { 
      body: sanitizeData(req.body),
      ip: req.ip 
    });
    
    return SyncResponseManager.sendErrorResponse(res, 500, 
      "Erro interno ao iniciar sincronização first-time", {
        error: error.message
      }
    );
  }
};

exports.syncFirstTimeFromStep = async (req, res) => {
  const logger = createApiContext('sync-first-time-from-step', 'POST');
  
  try {
    // Validação de parâmetros
    const validation = SyncRequestValidator.validateFirstTimeFromStepParams(req);
    
    if (!validation.isValid) {
      logger.warn('Parâmetros inválidos recebidos', {
        errors: validation.errors,
        body: sanitizeData(req.body)
      });
      
      return SyncResponseManager.sendValidationError(res, validation.errors);
    }

    const { empresa_id, accessToken, refresh_token, paginaAtual, startFromStep } = validation.params;

    // Verifica conflito de sincronização
    const conflictCheck = checkActiveSyncConflict(empresa_id, 'first-time');
    
    if (conflictCheck.hasConflict) {
      logger.warn('Sincronização já em andamento', {
        empresa_id,
        currentSync: conflictCheck.currentSync
      });
      
      return SyncResponseManager.sendErrorResponse(res, 409, 
        "Já existe uma sincronização first-time em andamento para esta empresa", {
          empresa_id,
          currentSync: conflictCheck.currentSync
        }
      );
    }

    // Calcula etapas puladas e restantes
    const skippedSteps = SyncRequestValidator.getSkippedSteps(startFromStep);
    const remainingSteps = SyncRequestValidator.getRemainingSteps(startFromStep);

    logger.info('Iniciando sincronização first-time a partir de etapa específica', {
      empresa_id,
      startFromStep,
      paginaAtual,
      skippedSteps,
      remainingSteps,
      ip: req.ip,
      userAgent: req.get('User-Agent')
    });

    // Responde imediatamente
    SyncResponseManager.sendAcceptedResponse(res, 'first-time', empresa_id, {
      paginaAtual,
      startFromStep,
      skippedSteps,
      remainingSteps,
      message: `Sincronização first-time iniciada a partir da etapa '${startFromStep}'. O processo está em execução em background.`,
      statusEndpoint: `/api/sync/status/${empresa_id}`,
      cancelEndpoint: `/api/sync/cancel/${empresa_id}/first-time`
    });

    // Processa em background
    setImmediate(async () => {
      await executeBackgroundSync(
        syncService.handleFirstTimeFromStep,
        { empresa_id, accessToken, refresh_token, paginaAtual, startFromStep },
        'first-time'
      );
    });

  } catch (error) {
    logError(error, 'syncFirstTimeFromStep', { 
      body: sanitizeData(req.body),
      ip: req.ip 
    });
    
    return SyncResponseManager.sendErrorResponse(res, 500, 
      "Erro interno ao iniciar sincronização first-time a partir de etapa específica", {
        error: error.message
      }
    );
  }
};

exports.syncDaily = async (req, res) => {
  const logger = createApiContext('sync-daily', 'POST');
  
  try {
    // Validação de parâmetros
    const validation = SyncRequestValidator.validateCommonParams(req);
    
    if (!validation.isValid) {
      logger.warn('Parâmetros inválidos recebidos', {
        errors: validation.errors,
        body: sanitizeData(req.body)
      });
      
      return SyncResponseManager.sendValidationError(res, validation.errors);
    }

    const { empresa_id, accessToken, refresh_token } = validation.params;

    // Verificar se first-time sync completou antes de permitir daily
    const { data: empresa } = await supabase
      .from('empresas')
      .select('sync_status')
      .eq('id', empresa_id)
      .maybeSingle();

    if (!empresa || empresa.sync_status !== 'completed') {
      logger.warn('First-time sync não completou, daily sync bloqueado', {
        empresa_id,
        syncStatus: empresa?.sync_status || 'unknown'
      });

      return SyncResponseManager.sendErrorResponse(res, 409,
        "First-time sync ainda não completou para esta empresa", {
          empresa_id,
          currentStatus: empresa?.sync_status || 'unknown'
        }
      );
    }

    // Verifica conflito de sincronização
    const conflictCheck = checkActiveSyncConflict(empresa_id, 'daily');

    if (conflictCheck.hasConflict) {
      logger.warn('Sincronização já em andamento', {
        empresa_id,
        currentSync: conflictCheck.currentSync
      });

      return SyncResponseManager.sendErrorResponse(res, 409,
        "Já existe uma sincronização em andamento para esta empresa", {
          empresa_id,
          currentSync: conflictCheck.currentSync
        }
      );
    }

    logger.info('Iniciando sincronização diária', {
      empresa_id,
      ip: req.ip,
      userAgent: req.get('User-Agent')
    });

    // Responde imediatamente
    SyncResponseManager.sendAcceptedResponse(res, 'diária', empresa_id, {
      statusEndpoint: `/api/sync/status/${empresa_id}`,
      cancelEndpoint: `/api/sync/cancel/${empresa_id}`
    });

    // Processa em background
    setImmediate(async () => {
      await executeBackgroundSync(
        syncService.handleDailySync,
        { empresa_id, accessToken, refresh_token },
        'daily'
      );
    });

  } catch (error) {
    logError(error, 'syncDaily', { 
      body: sanitizeData(req.body),
      ip: req.ip 
    });
    
    return SyncResponseManager.sendErrorResponse(res, 500, 
      "Erro interno ao iniciar sincronização diária", {
        error: error.message
      }
    );
  }
};

exports.syncInventory = async (req, res) => {
  const logger = createApiContext('sync-inventory', 'POST');

  try {
    // Validação de parâmetros
    const validation = SyncRequestValidator.validateCommonParams(req);

    if (!validation.isValid) {
      logger.warn('Parâmetros inválidos recebidos', {
        errors: validation.errors,
        body: sanitizeData(req.body)
      });

      return SyncResponseManager.sendValidationError(res, validation.errors);
    }

    const { empresa_id, accessToken, refresh_token } = validation.params;

    // Verificar se first-time sync completou antes de permitir inventory
    const { data: empresaInv } = await supabase
      .from('empresas')
      .select('sync_status')
      .eq('id', empresa_id)
      .maybeSingle();

    if (!empresaInv || empresaInv.sync_status !== 'completed') {
      logger.warn('First-time sync não completou, inventory sync bloqueado', {
        empresa_id,
        syncStatus: empresaInv?.sync_status || 'unknown'
      });

      return SyncResponseManager.sendErrorResponse(res, 409,
        "First-time sync ainda não completou para esta empresa", {
          empresa_id,
          currentStatus: empresaInv?.sync_status || 'unknown'
        }
      );
    }

    // Verifica conflito de sincronização
    const conflictCheck = checkActiveSyncConflict(empresa_id, 'inventory');

    if (conflictCheck.hasConflict) {
      logger.warn('Sincronização já em andamento', {
        empresa_id,
        currentSync: conflictCheck.currentSync
      });

      return SyncResponseManager.sendErrorResponse(res, 409,
        "Já existe uma sincronização em andamento para esta empresa", {
          empresa_id,
          currentSync: conflictCheck.currentSync
        }
      );
    }

    logger.info('Iniciando sincronização de estoque', {
      empresa_id,
      ip: req.ip,
      userAgent: req.get('User-Agent')
    });

    // Responde imediatamente
    SyncResponseManager.sendAcceptedResponse(res, 'de estoque', empresa_id, {
      statusEndpoint: `/api/sync/status/${empresa_id}`,
      cancelEndpoint: `/api/sync/cancel/${empresa_id}`
    });

    // Processa em background
    setImmediate(async () => {
      await executeBackgroundSync(
        syncService.handleInventorySync,
        { empresa_id, accessToken, refresh_token },
        'inventory'
      );
    });

  } catch (error) {
    logError(error, 'syncInventory', {
      body: sanitizeData(req.body),
      ip: req.ip
    });

    return SyncResponseManager.sendErrorResponse(res, 500,
      "Erro interno ao iniciar sincronização de estoque", {
        error: error.message
      }
    );
  }
};

exports.syncNfeTimestamps = async (req, res) => {
  const logger = createApiContext('sync-nfe-timestamps', 'POST');

  try {
    // Validacao de parametros
    const validation = SyncRequestValidator.validateCommonParams(req);

    if (!validation.isValid) {
      logger.warn('Parametros invalidos recebidos', {
        errors: validation.errors,
        body: sanitizeData(req.body)
      });

      return SyncResponseManager.sendValidationError(res, validation.errors);
    }

    const { empresa_id, accessToken, refresh_token } = validation.params;

    // Verifica conflito de sincronizacao
    const conflictCheck = checkActiveSyncConflict(empresa_id, 'nfe-timestamp');

    if (conflictCheck.hasConflict) {
      logger.warn('Sincronizacao ja em andamento', {
        empresa_id,
        currentSync: conflictCheck.currentSync
      });

      return SyncResponseManager.sendErrorResponse(res, 409,
        "Ja existe uma sincronizacao de timestamps de NFe em andamento para esta empresa", {
          empresa_id,
          currentSync: conflictCheck.currentSync
        }
      );
    }

    logger.info('Iniciando sincronizacao de timestamps de NFe', {
      empresa_id,
      ip: req.ip,
      userAgent: req.get('User-Agent')
    });

    // Responde imediatamente
    SyncResponseManager.sendAcceptedResponse(res, 'de timestamps de NFe', empresa_id, {
      statusEndpoint: `/api/sync/status/${empresa_id}`,
      cancelEndpoint: `/api/sync/cancel/${empresa_id}/nfe-timestamp`
    });

    // Processa em background
    setImmediate(async () => {
      await executeBackgroundSync(
        syncService.handleNfeTimestampSync,
        { empresa_id, accessToken, refresh_token },
        'nfe-timestamp'
      );
    });

  } catch (error) {
    logError(error, 'syncNfeTimestamps', {
      body: sanitizeData(req.body),
      ip: req.ip
    });

    return SyncResponseManager.sendErrorResponse(res, 500,
      "Erro interno ao iniciar sincronizacao de timestamps de NFe", {
        error: error.message
      }
    );
  }
};

// ===========================
// CONTROLLERS DE MONITORAMENTO
// ===========================

exports.getSyncStatus = async (req, res) => {
  const logger = createApiContext('get-sync-status', 'GET');
  
  try {
    const { empresa_id } = req.params;
    
    if (!empresa_id || !Number.isInteger(Number(empresa_id))) {
      return SyncResponseManager.sendErrorResponse(res, 400, 
        "empresa_id deve ser um número inteiro válido"
      );
    }

    const status = syncService.getSyncStatus(Number(empresa_id));
    
    logger.debug('Status de sincronização consultado', {
      empresa_id: Number(empresa_id),
      status: status.status,
      ip: req.ip
    });

    res.json(status);

  } catch (error) {
    logError(error, 'getSyncStatus', { 
      empresa_id: req.params.empresa_id,
      ip: req.ip 
    });
    
    return SyncResponseManager.sendErrorResponse(res, 500, 
      "Erro ao obter status da sincronização", {
        error: error.message
      }
    );
  }
};

exports.getAllActiveSyncs = async (req, res) => {
  const logger = createApiContext('get-all-active-syncs', 'GET');
  
  try {
    const activeSyncs = syncService.getAllActiveSyncs();
    
    logger.debug('Lista de sincronizações ativas consultada', {
      activeSyncsCount: activeSyncs.activeSyncsCount,
      ip: req.ip
    });

    res.json(activeSyncs);

  } catch (error) {
    logError(error, 'getAllActiveSyncs', { ip: req.ip });
    
    return SyncResponseManager.sendErrorResponse(res, 500, 
      "Erro ao obter sincronizações ativas", {
        error: error.message
      }
    );
  }
};

exports.cancelSync = async (req, res) => {
  const logger = createApiContext('cancel-sync', 'POST');
  
  try {
    const { empresa_id, syncType } = req.params;
    
    if (!empresa_id || !Number.isInteger(Number(empresa_id))) {
      return SyncResponseManager.sendErrorResponse(res, 400, 
        "empresa_id deve ser um número inteiro válido"
      );
    }

    if (!syncType || !['first-time', 'daily', 'inventory', 'nfe-timestamp'].includes(syncType)) {
      return SyncResponseManager.sendErrorResponse(res, 400,
        "syncType deve ser: first-time, daily, inventory ou nfe-timestamp"
      );
    }

    logger.info('Tentativa de cancelamento de sincronização', {
      empresa_id: Number(empresa_id),
      syncType,
      ip: req.ip,
      userAgent: req.get('User-Agent')
    });

    const result = await syncService.cancelSync(Number(empresa_id), syncType);
    
    if (result.success) {
      logger.info('Sincronização cancelada com sucesso', {
        empresa_id: Number(empresa_id),
        syncType
      });
      res.json(result);
    } else {
      logger.warn('Falha ao cancelar sincronização', {
        empresa_id: Number(empresa_id),
        syncType,
        reason: result.message
      });
      res.status(404).json(result);
    }

  } catch (error) {
    logError(error, 'cancelSync', { 
      empresa_id: req.params.empresa_id,
      syncType: req.params.syncType,
      ip: req.ip 
    });
    
    return SyncResponseManager.sendErrorResponse(res, 500, 
      "Erro ao cancelar sincronização", {
        error: error.message
      }
    );
  }
};

exports.getSyncPerformance = async (req, res) => {
  const logger = createApiContext('get-sync-performance', 'GET');
  
  try {
    const { empresa_id } = req.params;
    
    // Se empresa_id fornecida, valida
    if (empresa_id && !Number.isInteger(Number(empresa_id))) {
      return SyncResponseManager.sendErrorResponse(res, 400, 
        "empresa_id deve ser um número inteiro válido"
      );
    }

    const performance = syncService.getSyncPerformanceHistory(
      empresa_id ? Number(empresa_id) : null
    );
    
    logger.debug('Performance de sincronização consultada', {
      empresa_id: empresa_id ? Number(empresa_id) : 'global',
      ip: req.ip
    });

    if (empresa_id && !performance) {
      return SyncResponseManager.sendErrorResponse(res, 404, 
        "Nenhuma sincronização encontrada para esta empresa"
      );
    }

    res.json(performance);

  } catch (error) {
    logError(error, 'getSyncPerformance', { 
      empresa_id: req.params.empresa_id,
      ip: req.ip 
    });
    
    return SyncResponseManager.sendErrorResponse(res, 500, 
      "Erro ao obter performance da sincronização", {
        error: error.message
      }
    );
  }
};