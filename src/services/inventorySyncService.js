// src/services/inventorySyncService.js
require("dotenv").config();
const { getDelay, getRetryConfig, SYNC } = require("../config/SyncConfig");
const delay = require("../utils/delay");
const { getValidBlingToken } = require("./blingTokenService");
const { callEdgeFunction } = require("./edgeFunctionService");
const { getSyncMetrics } = require("./metricsService");
const { 
    createSyncContext, 
    logOperationStart, 
    logOperationEnd, 
    logError,
    logPaginationProgress 
} = require("../utils/logger");

// ===========================
// FUNÇÃO AUXILIAR DE PAGINAÇÃO
// ===========================

/**
 * Sincronização de estoque com paginação, logging e métricas integradas
 */
async function syncEstoqueWithPagination(empresa_id, access_token, refresh_token) {
    let nextPage = 1;
    let isPaginationFinished = false;
    let totalRecordsProcessed = 0;
    
    const stepName = 'estoque';
    const logger = createSyncContext(empresa_id, 'inventory', stepName);
    const metrics = getSyncMetrics(empresa_id, 'inventory');

    logger.info('Iniciando sincronização de estoque com paginação', {
        stepName,
        startPage: nextPage
    });

    while (!isPaginationFinished) {
        try {
            logger.debug('Iniciando requisição de página de estoque', {
                stepName,
                page: nextPage
            });
            
            // Usa o novo serviço de Edge Function com retry e rate limiting
            const result = await callEdgeFunction(
                `${process.env.SUPABASE_URL}/functions/v1/sync_estoque`,
                { 
                    page: nextPage || 1,
                    empresa_id: Number(empresa_id),
                    access_token
                },
                empresa_id,
                access_token,
                refresh_token,
                { 
                    context: 'default',
                    maxRetries: 20,
                    initialDelay: 2000,
                    backoffFactor: 1.5
                }
            );
            
            // Registra progresso nas métricas se disponíveis
            if (metrics) {
                const recordCount = result?.data?.length || result?.quantidade || 0;
                metrics.pageProcessed(nextPage, recordCount);
                totalRecordsProcessed += recordCount;
            }

            // Log de progresso
            logPaginationProgress(nextPage, totalRecordsProcessed, stepName, {
                empresa_id,
                syncType: 'inventory'
            });

            logger.info('Página de estoque sincronizada', {
                stepName,
                page: nextPage,
                recordsInPage: result?.data?.length || result?.quantidade || 0,
                totalRecords: totalRecordsProcessed
            });
            
            // Lógica de paginação usando next_page
            nextPage = result?.next_page ?? null;
            isPaginationFinished = nextPage === null;
            
            if (isPaginationFinished) {
                logger.info('Paginação de estoque finalizada', {
                    stepName,
                    totalPages: nextPage || 1,
                    totalRecords: totalRecordsProcessed
                });
            } else {
                logger.debug('Próxima página de estoque identificada', {
                    stepName,
                    nextPage
                });
            }
            
            // Delay entre páginas (só se ainda tiver mais páginas)
            if (!isPaginationFinished) {
                const delayTime = getDelay('pagination', 'inventory');
                logger.debug('Aplicando delay entre páginas de estoque', {
                    stepName,
                    delayTime: `${delayTime}ms`
                });
                await delay(delayTime);
            }
            
        } catch (error) {
            // Registra erro nas métricas
            if (metrics) {
                metrics.recordError(error, {
                    stepName,
                    page: nextPage,
                    operation: 'sync_estoque'
                });
            }
            
            logError(error, `syncEstoqueWithPagination`, {
                empresa_id,
                page: nextPage,
                stepName
            });
            
            logger.error('Erro fatal na sincronização de estoque', {
                stepName,
                page: nextPage,
                error: error.message
            });
            
            throw error;
        }
    }

    logger.info('Sincronização de estoque concluída', {
        stepName,
        totalRecords: totalRecordsProcessed,
        totalPages: nextPage || 1
    });

    return { totalRecordsProcessed, totalPages: nextPage || 1 };
}

// ===========================
// FLUXO PRINCIPAL
// ===========================

/**
 * Executa sincronização completa de estoque (inventário)
 */
async function executeInventorySync(empresa_id, access_token, refresh_token) {
    const logger = createSyncContext(empresa_id, 'inventory', 'main-flow');
    const metrics = getSyncMetrics(empresa_id, 'inventory');

    logOperationStart('executeInventorySync', { empresa_id });
    
    if (metrics) {
        metrics.startStep('inventory-sync');
    }

    try {
        logger.info('Iniciando sincronização de estoque', {
            empresa_id,
            operation: 'executeInventorySync'
        });

        // Obtém um token válido
        const token = await getValidBlingToken(Number(empresa_id), access_token, refresh_token);
        
        logger.info('Token válido obtido para sincronização de estoque', {
            tokenPreview: `${token.substring(0, 8)}***`
        });

        // Executa a sincronização de estoque com paginação
        const result = await syncEstoqueWithPagination(empresa_id, token, refresh_token);

        // Calcula estatísticas finais
        const finalStats = {
            success: true,
            message: "Sincronização de estoque concluída com sucesso",
            empresa_id: Number(empresa_id),
            totalRecords: result.totalRecordsProcessed,
            totalPages: result.totalPages,
            ...(metrics && {
                recordsProcessed: metrics.metrics.recordsProcessed.value,
                pagesProcessed: metrics.metrics.pagesProcessed.value,
                errorsCount: metrics.metrics.errorsCount.value,
                retriesCount: metrics.metrics.retriesCount.value
            })
        };

        if (metrics) {
            metrics.endStep('completed');
        }

        logOperationEnd('executeInventorySync', true, {
            empresa_id,
            ...finalStats
        });

        logger.info('Sincronização de estoque concluída com sucesso', {
            ...finalStats,
            duration: metrics ? `${Date.now() - metrics.startTime}ms` : 'N/A'
        });

        return finalStats;

    } catch (error) {
        const errorStats = {
            success: false,
            message: "Erro durante a sincronização de estoque",
            error: error.message || "Erro desconhecido",
            empresa_id: Number(empresa_id),
            ...(metrics && {
                recordsProcessed: metrics.metrics.recordsProcessed.value,
                errorsCount: metrics.metrics.errorsCount.value,
                duration: Date.now() - metrics.startTime
            })
        };

        if (metrics) {
            metrics.recordError(error, { operation: 'executeInventorySync' });
            metrics.endStep('failed');
        }

        logOperationEnd('executeInventorySync', false, {
            empresa_id,
            error: error.message
        });

        logError(error, 'executeInventorySync', {
            empresa_id,
            ...errorStats
        });

        logger.error('Erro na sincronização de estoque', {
            error: error.message,
            ...errorStats
        });

        return errorStats;
    }
}

// ===========================
// EXPORTAÇÕES
// ===========================

module.exports = {
    executeInventorySync,
    
    // Função auxiliar (para casos avançados)
    syncEstoqueWithPagination
};