// src/services/syncService.js
require("dotenv").config();
const { getValidBlingToken } = require("./blingTokenService");
const { executeSteps } = require("./stepService"); // Fluxo completo (first-time)
const { executeDailySync } = require("./dailySyncService"); // Fluxo diário
const { executeInventorySync } = require("./inventorySyncService"); // Fluxo de estoque
const { executeNfeTimestampSync } = require("./nfeTimestampSyncService"); // Fluxo de timestamps de NFe
const { startSync, finishSync, getSyncMetrics } = require("./metricsService");
const supabase = require("./supabaseService");
const { 
  createSyncContext, 
  logOperationStart, 
  logOperationEnd, 
  logError,
  sanitizeData 
} = require("../utils/logger");
const { getTimeout } = require("../config/SyncConfig");

/**
 * Classe para gerenciar operações de sincronização com métricas e logging
 */
class SyncOperationManager {
  constructor(empresa_id, syncType, operation) {
    this.empresa_id = Number(empresa_id);
    this.syncType = syncType;
    this.operation = operation;
    this.logger = createSyncContext(empresa_id, syncType, operation);
    this.metrics = null;
    this.startTime = Date.now();
  }

  /**
   * Inicia a operação de sincronização
   */
  start() {
    // Inicia métricas
    this.metrics = startSync(this.empresa_id, this.syncType, this.operation);
    
    // Log de início
    logOperationStart(`${this.syncType}Sync`, {
      empresa_id: this.empresa_id,
      operation: this.operation,
      syncType: this.syncType
    });

    this.logger.info('Sincronização iniciada', {
      operation: this.operation,
      startTime: new Date(this.startTime).toISOString()
    });

    return this;
  }

  /**
   * Finaliza a operação de sincronização
   */
  finish(success, result = null, error = null) {
    const endTime = Date.now();
    const duration = endTime - this.startTime;
    const status = success ? 'completed' : 'failed';

    // Finaliza métricas
    if (this.metrics) {
      finishSync(this.empresa_id, this.syncType, status);
    }

    // Log de finalização
    logOperationEnd(`${this.syncType}Sync`, success, {
      empresa_id: this.empresa_id,
      operation: this.operation,
      duration: `${duration}ms`,
      ...(result && { result: sanitizeData(result) }),
      ...(error && { error: error.message })
    });

    if (success) {
      this.logger.info('Sincronização concluída com sucesso', {
        operation: this.operation,
        duration: `${duration}ms`,
        recordsProcessed: result?.recordsProcessed || 0
      });
    } else {
      this.logger.error('Sincronização falhou', {
        operation: this.operation,
        duration: `${duration}ms`,
        error: error?.message || 'Erro desconhecido'
      });
    }

    return this;
  }

  /**
   * Obtém token válido com logging
   */
  async getValidToken(accessToken, refresh_token) {
    this.logger.debug('Obtendo token válido');

    try {
      const token = await getValidBlingToken(this.empresa_id, accessToken, refresh_token);

      this.logger.info('Token válido obtido', {
        tokenPreview: `${token.substring(0, 8)}***`
      });

      return token;
    } catch (error) {
      logError(error, 'getValidToken', {
        empresa_id: this.empresa_id,
        hasAccessToken: !!accessToken,
        hasRefreshToken: !!refresh_token
      });

      // ✅ CORREÇÃO: Detectar token revogado e parar sync gracefully
      if (error.isRevoked) {
        this.logger.error('Token revogado - sincronização cancelada', {
          operation: 'getValidToken',
          empresa_id: this.empresa_id,
          message: 'Usuário precisa reautorizar no Bling'
        });

        // Criar erro específico para token revogado
        const revokedError = new Error(`Sincronização cancelada: Token revogado para empresa ${this.empresa_id}. Reautorização necessária.`);
        revokedError.isRevoked = true;
        revokedError.empresa_id = this.empresa_id;
        revokedError.code = 'TOKEN_REVOKED';
        throw revokedError;
      }

      throw error;
    }
  }

  /**
   * Executa operação com timeout
   */
  async executeWithTimeout(operation, timeoutType = 'total') {
    const timeout = getTimeout(timeoutType);
    
    return Promise.race([
      operation(),
      new Promise((_, reject) => {
        setTimeout(() => {
          reject(new Error(`Operação excedeu timeout de ${timeout}ms`));
        }, timeout);
      })
    ]);
  }

  /**
   * Obtém métricas atuais da sincronização
   */
  getCurrentMetrics() {
    return getSyncMetrics(this.empresa_id, this.syncType);
  }
}

/**
 * Executa steps a partir de uma etapa específica
 */
async function executeStepsFromSpecificStep(empresa_id, accessToken, refresh_token, paginaAtual, startFromStep) {
  const { getDelay } = require("../config/SyncConfig");
  const delay = require("../utils/delay");
  
  // Importa as funções de step individuais
  const { 
    etapaProdutos,
    etapaFornecedores, 
    etapaPedidosVenda,
    etapaPedidosCompra,
    etapaNotasFiscais
  } = require("./stepService");

  const logger = createSyncContext(empresa_id, 'first-time', `from-${startFromStep}`);
  
  try {
    logger.info(`Iniciando sincronização first-time a partir da etapa: ${startFromStep}`, {
      empresa_id,
      startFromStep,
      paginaAtual
    });

    // Mapeamento de etapas para funções
    const stepFunctions = {
      'produtos': () => etapaProdutos(empresa_id, accessToken, refresh_token, paginaAtual),
      'fornecedores': () => etapaFornecedores(empresa_id, accessToken, refresh_token),
      'pedidos-venda': () => etapaPedidosVenda(empresa_id, accessToken, refresh_token),
      'pedidos-compra': () => etapaPedidosCompra(empresa_id, accessToken, refresh_token),
      'notas-fiscais': () => etapaNotasFiscais(empresa_id, accessToken, refresh_token)
    };

    // Lista ordenada de etapas
    const allSteps = ['produtos', 'fornecedores', 'pedidos-venda', 'pedidos-compra', 'notas-fiscais'];
    const startIndex = allSteps.indexOf(startFromStep);
    
    if (startIndex === -1) {
      throw new Error(`Etapa '${startFromStep}' não encontrada`);
    }

    // Executa apenas as etapas a partir da solicitada
    const stepsToExecute = allSteps.slice(startIndex);
    
    logger.info(`Executando ${stepsToExecute.length} etapas`, {
      stepsToExecute,
      skippedSteps: allSteps.slice(0, startIndex)
    });

    for (let i = 0; i < stepsToExecute.length; i++) {
      const stepName = stepsToExecute[i];
      const stepNumber = startIndex + i + 1;
      
      logger.info(`Iniciando etapa ${stepNumber}/5: ${stepName}`, {
        stepName,
        stepNumber,
        totalSteps: 5
      });

      try {
        // Executa a etapa
        await stepFunctions[stepName]();
        
        logger.info(`Etapa ${stepNumber}/5 concluída: ${stepName}`, {
          stepName,
          stepNumber
        });

        // Delay entre etapas (exceto na última)
        if (i < stepsToExecute.length - 1) {
          const delayTime = getDelay('steps');
          logger.info(`Aguardando ${delayTime/1000}s antes da próxima etapa...`);
          await delay(delayTime);
        }

      } catch (error) {
        logger.error(`Erro na etapa ${stepNumber}/5: ${stepName}`, {
          stepName,
          stepNumber,
          error: error.message
        });
        throw error;
      }
    }

    logger.info('Sincronização first-time concluída com sucesso', {
      totalStepsExecuted: stepsToExecute.length,
      stepsExecuted: stepsToExecute
    });

    return { 
      success: true, 
      message: `Sincronização first-time concluída a partir da etapa '${startFromStep}'`,
      startFromStep,
      stepsExecuted: stepsToExecute,
      totalStepsExecuted: stepsToExecute.length
    };

  } catch (error) {
    logger.error('Erro durante a sincronização first-time', {
      error: error.message,
      startFromStep
    });
    
    return { 
      success: false, 
      message: `Erro durante a sincronização first-time a partir da etapa '${startFromStep}'`, 
      error: error.message || "Erro desconhecido",
      startFromStep
    };
  }
}

/**
 * Fluxo completo para sincronização first-time.
 * Executa todos os steps definidos no stepService.js.
 */
async function handleFirstTimeSync({ empresa_id, accessToken, refresh_token, paginaAtual = 1 }) {
  const syncManager = new SyncOperationManager(empresa_id, 'first-time', 'full-sync');
  
  try {
    // Inicia operação
    syncManager.start();

    // Obtém token válido
    const token = await syncManager.getValidToken(accessToken, refresh_token);

    // Executa sincronização completa com timeout
    const result = await syncManager.executeWithTimeout(async () => {
      return await executeStepsFromSpecificStep(empresa_id, token, refresh_token, paginaAtual, 'produtos');
    }, 'total');

    // Finaliza com sucesso
    syncManager.finish(true, result);

    // Marcar first-time sync como concluída
    await supabase.from('empresas')
      .update({ sync_status: 'completed' })
      .eq('id', empresa_id);

    return {
      ...result,
      metrics: syncManager.getCurrentMetrics()?.getReport()
    };

  } catch (error) {
    // Finaliza com erro
    syncManager.finish(false, null, error);

    // Marcar first-time sync como erro
    await supabase.from('empresas')
      .update({ sync_status: 'error' })
      .eq('id', empresa_id);

    return {
      success: false,
      message: "Erro durante a sincronização first-time",
      error: error.message || "Erro desconhecido",
      metrics: syncManager.getCurrentMetrics()?.getReport()
    };
  }
}

/**
 * Fluxo first-time a partir de uma etapa específica.
 * Pula etapas anteriores e executa a partir da etapa solicitada.
 */
async function handleFirstTimeFromStep({ empresa_id, accessToken, refresh_token, paginaAtual = 1, startFromStep }) {
  const syncManager = new SyncOperationManager(empresa_id, 'first-time', `partial-sync-from-${startFromStep}`);
  
  try {
    // Inicia operação
    syncManager.start();

    // Obtém token válido
    const token = await syncManager.getValidToken(accessToken, refresh_token);

    syncManager.logger.info('Iniciando sincronização first-time a partir de etapa específica', {
      startFromStep,
      paginaAtual
    });

    // Executa sincronização com timeout
    const result = await syncManager.executeWithTimeout(async () => {
      return await executeStepsFromSpecificStep(empresa_id, token, refresh_token, paginaAtual, startFromStep);
    }, 'total');

    // Finaliza com sucesso
    syncManager.finish(true, result);

    // Marcar first-time sync como concluída
    await supabase.from('empresas')
      .update({ sync_status: 'completed' })
      .eq('id', empresa_id);

    return {
      ...result,
      startFromStep,
      metrics: syncManager.getCurrentMetrics()?.getReport()
    };

  } catch (error) {
    // Finaliza com erro
    syncManager.finish(false, null, error);

    // Marcar first-time sync como erro
    await supabase.from('empresas')
      .update({ sync_status: 'error' })
      .eq('id', empresa_id);

    return {
      success: false,
      message: `Erro durante a sincronização first-time a partir da etapa ${startFromStep}`,
      error: error.message || "Erro desconhecido",
      startFromStep,
      metrics: syncManager.getCurrentMetrics()?.getReport()
    };
  }
}

/**
 * Fluxo diário para sincronização incremental.
 * Esse fluxo atualiza somente os dados recentes.
 */
async function handleDailySync({ empresa_id, accessToken, refresh_token }) {
  const syncManager = new SyncOperationManager(empresa_id, 'daily', 'incremental-sync');
  
  try {
    // Inicia operação
    syncManager.start();

    // Obtém token válido
    const token = await syncManager.getValidToken(accessToken, refresh_token);

    // Executa sincronização com timeout
    const result = await syncManager.executeWithTimeout(async () => {
      return await executeDailySync(empresa_id, token, refresh_token);
    }, 'total');

    // Finaliza com sucesso
    syncManager.finish(true, result);
    
    return {
      ...result,
      metrics: syncManager.getCurrentMetrics()?.getReport()
    };

  } catch (error) {
    // Finaliza com erro
    syncManager.finish(false, null, error);
    
    return { 
      success: false, 
      message: "Erro durante a sincronização diária", 
      error: error.message || "Erro desconhecido",
      metrics: syncManager.getCurrentMetrics()?.getReport()
    };
  }
}

/**
 * Fluxo para sincronização de estoque.
 * Esse fluxo é dedicado exclusivamente à atualização dos dados de inventário.
 */
async function handleInventorySync({ empresa_id, accessToken, refresh_token }) {
  const syncManager = new SyncOperationManager(empresa_id, 'inventory', 'stock-sync');
  
  try {
    // Inicia operação
    syncManager.start();

    // Obtém token válido
    const token = await syncManager.getValidToken(accessToken, refresh_token);

    // Executa sincronização com timeout
    const result = await syncManager.executeWithTimeout(async () => {
      return await executeInventorySync(empresa_id, token, refresh_token);
    }, 'total');

    // Finaliza com sucesso
    syncManager.finish(true, result);
    
    return {
      ...result,
      metrics: syncManager.getCurrentMetrics()?.getReport()
    };

  } catch (error) {
    // Finaliza com erro
    syncManager.finish(false, null, error);
    
    return { 
      success: false, 
      message: "Erro durante a sincronização de estoque", 
      error: error.message || "Erro desconhecido",
      metrics: syncManager.getCurrentMetrics()?.getReport()
    };
  }
}

/**
 * Fluxo para sincronizacao de timestamps de NFe.
 * Esse fluxo busca os timestamps de emissao das notas fiscais de saida
 * para popular a tabela pedido_venda_timestamp (usada para mapa de calor).
 */
async function handleNfeTimestampSync({ empresa_id, accessToken, refresh_token }) {
  const syncManager = new SyncOperationManager(empresa_id, 'nfe-timestamp', 'timestamp-sync');

  try {
    // Inicia operacao
    syncManager.start();

    // Obtem token valido
    const token = await syncManager.getValidToken(accessToken, refresh_token);

    // Executa sincronizacao com timeout
    const result = await syncManager.executeWithTimeout(async () => {
      return await executeNfeTimestampSync(empresa_id, token, refresh_token);
    }, 'total');

    // Finaliza com sucesso
    syncManager.finish(true, result);

    return {
      ...result,
      metrics: syncManager.getCurrentMetrics()?.getReport()
    };

  } catch (error) {
    // Finaliza com erro
    syncManager.finish(false, null, error);

    return {
      success: false,
      message: "Erro durante a sincronizacao de timestamps de NFe",
      error: error.message || "Erro desconhecido",
      metrics: syncManager.getCurrentMetrics()?.getReport()
    };
  }
}

/**
 * Obtém status de todas as sincronizações ativas de uma empresa
 */
function getSyncStatus(empresa_id) {
  const { getCompanySyncMetrics } = require("./metricsService");
  const companySyncs = getCompanySyncMetrics(empresa_id);
  
  if (!companySyncs || companySyncs.length === 0) {
    return {
      status: 'idle',
      message: 'Nenhuma sincronização em andamento',
      empresa_id: Number(empresa_id),
      activeSyncs: [],
      totalActiveSyncs: 0
    };
  }

  return {
    status: 'running',
    empresa_id: Number(empresa_id),
    activeSyncs: companySyncs.map(sync => {
      const report = sync.metrics.getReport();
      return {
        syncType: sync.syncType,
        operation: sync.operation,
        currentStep: sync.metrics.currentStep,
        progress: {
          recordsProcessed: report.summary.recordsProcessed,
          pagesProcessed: report.summary.pagesProcessed,
          errorsCount: report.summary.errorsCount,
          duration: report.duration
        },
        startTime: report.startTime
      };
    }),
    totalActiveSyncs: companySyncs.length
  };
}

/**
 * Lista todas as sincronizações ativas
 */
function getAllActiveSyncs() {
  const { getGlobalMetrics } = require("./metricsService");
  const globalMetrics = getGlobalMetrics();
  
  return {
    activeSyncsCount: globalMetrics.activeSyncs.length,
    activeSyncs: globalMetrics.activeSyncs.map(sync => ({
      empresa_id: sync.empresa_id,
      syncType: sync.syncType,
      operation: sync.operation,
      status: sync.status,
      currentStep: sync.currentStep,
      startTime: sync.startTime,
      recordsProcessed: sync.recordsProcessed
    })),
    systemMetrics: {
      totalSyncs: globalMetrics.metrics.total_syncs?.value || 0,
      systemMemoryMB: globalMetrics.metrics.system_memory?.value || 0,
      uptimeSeconds: globalMetrics.metrics.uptime?.value || 0
    },
    timestamp: globalMetrics.timestamp
  };
}

/**
 * Cancela sincronização específica em andamento
 */
async function cancelSync(empresa_id, syncType) {
  const syncManager = new SyncOperationManager(empresa_id, 'unknown', 'cancel');
  
  try {
    const { getSyncMetrics, finishSync } = require("./metricsService");
    const metrics = getSyncMetrics(empresa_id, syncType);
    
    if (!metrics) {
      return {
        success: false,
        message: `Nenhuma sincronização ${syncType} ativa encontrada`,
        empresa_id: Number(empresa_id),
        syncType
      };
    }

    // Finaliza métricas como cancelada
    finishSync(empresa_id, syncType, 'cancelled');
    
    syncManager.logger.warn('Sincronização cancelada pelo usuário', {
      empresa_id,
      syncType,
      cancelledAt: new Date().toISOString()
    });

    return {
      success: true,
      message: 'Sincronização cancelada com sucesso',
      empresa_id: Number(empresa_id),
      syncType,
      cancelledAt: new Date().toISOString()
    };

  } catch (error) {
    logError(error, 'cancelSync', { empresa_id, syncType });
    
    return {
      success: false,
      message: 'Erro ao cancelar sincronização',
      error: error.message,
      empresa_id: Number(empresa_id),
      syncType
    };
  }
}

/**
 * Obtém histórico de performance de sincronizações
 */
function getSyncPerformanceHistory(empresa_id = null) {
  const { getGlobalMetrics, getCompanyHistory } = require("./metricsService");
  
  // Se empresa_id específica for fornecida
  if (empresa_id) {
    return getCompanyHistory(empresa_id);
  }
  
  // Retorna métricas globais
  const globalMetrics = getGlobalMetrics();
  return {
    systemOverview: globalMetrics.metrics,
    activeSyncs: globalMetrics.activeSyncs,
    byCompany: globalMetrics.byCompany,
    timestamp: globalMetrics.timestamp
  };
}

// ===========================
// EXPORTAÇÕES
// ===========================

module.exports = {
  // Funções principais (compatibilidade mantida)
  handleFirstTimeSync,
  handleFirstTimeFromStep, // ✨ Nova função
  handleDailySync,
  handleInventorySync,
  handleNfeTimestampSync, // Sync de timestamps de NFe

  // Novas funcionalidades de monitoramento
  getSyncStatus,
  getAllActiveSyncs,
  cancelSync,
  getSyncPerformanceHistory,

  // Classe utilitária (para casos avançados)
  SyncOperationManager
};