// src/services/inventorySyncService.js - VERSÃO MELHORADA E CONSISTENTE
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
 * Versão melhorada para sincronização de inventário
 */
async function syncEstoqueWithPagination(empresa_id, access_token, refresh_token) {
    let nextPage = 1;
    let isPaginationFinished = false;
    let totalRecordsProcessed = 0;
    let totalPagesProcessed = 0;
    
    const stepName = 'estoque';
    const logger = createSyncContext(empresa_id, 'inventory', stepName);
    const metrics = getSyncMetrics(empresa_id, 'inventory');

    logger.info('Iniciando sincronização de estoque com paginação', {
        stepName,
        startPage: nextPage,
        url: 'sync_estoque'
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
            
            // Conta a página processada
            totalPagesProcessed++;
            
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

            logger.info('Página de estoque sincronizada com sucesso', {
                stepName,
                page: nextPage,
                recordsInPage: result?.data?.length || result?.quantidade || 0,
                totalRecords: totalRecordsProcessed,
                totalPages: totalPagesProcessed
            });
            
            // Lógica de paginação usando next_page
            nextPage = result?.next_page ?? null;
            isPaginationFinished = nextPage === null;
            
            if (isPaginationFinished) {
                logger.info('Paginação de estoque finalizada', {
                    stepName,
                    totalPagesProcessed,
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
                stepName,
                totalPagesProcessed,
                totalRecordsProcessed
            });
            
            logger.error('Erro fatal na sincronização de estoque', {
                stepName,
                page: nextPage,
                error: error.message,
                totalPagesProcessed,
                totalRecordsProcessed
            });
            
            throw error;
        }
    }

    logger.info('Sincronização de estoque concluída com sucesso', {
        stepName,
        totalRecords: totalRecordsProcessed,
        totalPages: totalPagesProcessed
    });

    return { 
        totalRecordsProcessed, 
        totalPages: totalPagesProcessed
    };
}

// ===========================
// FUNÇÃO AUXILIAR PARA MÚLTIPLAS OPERAÇÕES DE ESTOQUE
// ===========================

/**
 * ✅ NOVA FUNÇÃO: Executa operações relacionadas ao estoque
 */
async function executeInventoryOperations(empresa_id, access_token, refresh_token) {
    const stepName = 'inventory-operations';
    const logger = createSyncContext(empresa_id, 'inventory', stepName);
    const metrics = getSyncMetrics(empresa_id, 'inventory');
    
    logger.info('Iniciando operações completas de inventário', { 
        stepName,
        totalOperations: 2
    });

    const results = {
        estoque: null,
        movimentacoes: null,
        totalRecords: 0
    };

    try {
        // Operação 1: Sincronização de estoque
        logger.info('Operação 1/2: Sincronizando dados de estoque', { stepName });
        
        results.estoque = await syncEstoqueWithPagination(empresa_id, access_token, refresh_token);
        results.totalRecords += results.estoque.totalRecordsProcessed;
        
        logger.info('Operação 1/2 concluída', {
            stepName,
            totalRecords: results.estoque.totalRecordsProcessed,
            totalPages: results.estoque.totalPages
        });

        // Delay entre operações
        const delayTime = getDelay('steps', 'mini');
        logger.debug('Delay entre operações de inventário', {
            stepName,
            delayTime: `${delayTime}ms`
        });
        await delay(delayTime);

        // Operação 2: Sincronização de movimentações de estoque (se disponível)
        logger.info('Operação 2/2: Sincronizando movimentações de estoque', { stepName });
        
        try {
            const movimentacoesResult = await callEdgeFunction(
                `${process.env.SUPABASE_URL}/functions/v1/sync_movimentacoes_estoque`,
                { 
                    empresa_id: Number(empresa_id),
                    access_token
                },
                empresa_id,
                access_token,
                refresh_token,
                { 
                    context: 'default',
                    maxRetries: 10,
                    initialDelay: 2000,
                    backoffFactor: 1.5
                }
            );
            
            results.movimentacoes = {
                totalRecordsProcessed: movimentacoesResult?.recordsProcessed || 0,
                success: true
            };
            
            results.totalRecords += results.movimentacoes.totalRecordsProcessed;
            
            if (metrics) {
                metrics.recordsProcessed(results.movimentacoes.totalRecordsProcessed);
            }
            
            logger.info('Operação 2/2 concluída', {
                stepName,
                totalRecords: results.movimentacoes.totalRecordsProcessed
            });
            
        } catch (movError) {
            // Movimentações são opcionais, registra erro mas continua
            results.movimentacoes = {
                totalRecordsProcessed: 0,
                success: false,
                error: movError.message
            };
            
            if (metrics) {
                metrics.recordError(movError, { 
                    stepName, 
                    operation: 'movimentacoes_estoque',
                    optional: true 
                });
            }
            
            logger.warn('Operação 2/2 falhou (opcional)', {
                stepName,
                error: movError.message
            });
        }

        logger.info('Operações de inventário concluídas', {
            stepName,
            totalRecords: results.totalRecords,
            estoqueRecords: results.estoque.totalRecordsProcessed,
            movimentacoesRecords: results.movimentacoes?.totalRecordsProcessed || 0
        });

        return results;

    } catch (error) {
        logger.error('Erro nas operações de inventário', {
            stepName,
            error: error.message
        });
        throw error;
    }
}

// ===========================
// FLUXO PRINCIPAL
// ===========================

/**
 * Executa sincronização completa de estoque (inventário)
 * Versão melhorada com operações múltiplas
 */
async function executeInventorySync(empresa_id, access_token, refresh_token) {
    const logger = createSyncContext(empresa_id, 'inventory', 'main-flow');
    const metrics = getSyncMetrics(empresa_id, 'inventory');

    logOperationStart('executeInventorySync', { empresa_id });
    
    if (metrics) {
        metrics.startStep('inventory-sync');
    }

    try {
        logger.info('Iniciando sincronização completa de inventário', {
            empresa_id,
            operation: 'executeInventorySync',
            includeMovements: true
        });

        // Obtém um token válido
        const token = await getValidBlingToken(Number(empresa_id), access_token, refresh_token);
        
        logger.info('Token válido obtido para sincronização de inventário', {
            tokenPreview: `${token.substring(0, 8)}***`
        });

        // Executa as operações completas de inventário
        const inventoryResults = await executeInventoryOperations(empresa_id, token, refresh_token);

        // Calcula estatísticas finais
        const finalStats = {
            success: true,
            message: "Sincronização de inventário concluída com sucesso",
            empresa_id: Number(empresa_id),
            totalRecords: inventoryResults.totalRecords,
            totalPages: inventoryResults.estoque.totalPages,
            operations: {
                estoque: {
                    records: inventoryResults.estoque.totalRecordsProcessed,
                    pages: inventoryResults.estoque.totalPages,
                    success: true
                },
                movimentacoes: inventoryResults.movimentacoes ? {
                    records: inventoryResults.movimentacoes.totalRecordsProcessed,
                    success: inventoryResults.movimentacoes.success,
                    ...(inventoryResults.movimentacoes.error && { 
                        error: inventoryResults.movimentacoes.error 
                    })
                } : {
                    records: 0,
                    success: false,
                    error: "Operação não executada"
                }
            },
            ...(metrics && {
                metricsRecordsProcessed: metrics.metrics.recordsProcessed.value,
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

        logger.info('Sincronização de inventário concluída com sucesso', {
            ...finalStats,
            duration: metrics ? `${Date.now() - metrics.startTime}ms` : 'N/A'
        });

        return finalStats;

    } catch (error) {
        const errorStats = {
            success: false,
            message: "Erro durante a sincronização de inventário",
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

        logger.error('Erro na sincronização de inventário', {
            error: error.message,
            ...errorStats
        });

        return errorStats;
    }
}

// ===========================
// FUNÇÃO SIMPLIFICADA (COMPATIBILIDADE)
// ===========================

/**
 * ✅ FUNÇÃO SIMPLIFICADA: Para casos que precisam apenas do estoque básico
 */
async function executeSimpleInventorySync(empresa_id, access_token, refresh_token) {
    const logger = createSyncContext(empresa_id, 'inventory', 'simple-sync');
    const metrics = getSyncMetrics(empresa_id, 'inventory');

    logOperationStart('executeSimpleInventorySync', { empresa_id });
    
    if (metrics) {
        metrics.startStep('simple-inventory-sync');
    }

    try {
        logger.info('Iniciando sincronização simples de estoque', {
            empresa_id,
            operation: 'executeSimpleInventorySync'
        });

        // Obtém um token válido
        const token = await getValidBlingToken(Number(empresa_id), access_token, refresh_token);
        
        logger.info('Token válido obtido para sincronização simples', {
            tokenPreview: `${token.substring(0, 8)}***`
        });

        // Executa apenas a sincronização de estoque
        const result = await syncEstoqueWithPagination(empresa_id, token, refresh_token);

        const finalStats = {
            success: true,
            message: "Sincronização simples de estoque concluída com sucesso",
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

        logOperationEnd('executeSimpleInventorySync', true, {
            empresa_id,
            ...finalStats
        });

        logger.info('Sincronização simples de estoque concluída', {
            ...finalStats,
            duration: metrics ? `${Date.now() - metrics.startTime}ms` : 'N/A'
        });

        return finalStats;

    } catch (error) {
        const errorStats = {
            success: false,
            message: "Erro durante a sincronização simples de estoque",
            error: error.message || "Erro desconhecido",
            empresa_id: Number(empresa_id),
            ...(metrics && {
                recordsProcessed: metrics.metrics.recordsProcessed.value,
                errorsCount: metrics.metrics.errorsCount.value,
                duration: Date.now() - metrics.startTime
            })
        };

        if (metrics) {
            metrics.recordError(error, { operation: 'executeSimpleInventorySync' });
            metrics.endStep('failed');
        }

        logOperationEnd('executeSimpleInventorySync', false, {
            empresa_id,
            error: error.message
        });

        logError(error, 'executeSimpleInventorySync', {
            empresa_id,
            ...errorStats
        });

        return errorStats;
    }
}

// ===========================
// FUNÇÕES UTILITÁRIAS
// ===========================

/**
 * ✅ NOVA FUNÇÃO: Obtém estatísticas do inventário
 */
function getInventoryStats(empresa_id) {
    const metrics = getSyncMetrics(empresa_id, 'inventory');
    
    if (!metrics) {
        return {
            hasActiveSync: false,
            message: 'Nenhuma sincronização de inventário ativa'
        };
    }
    
    return {
        hasActiveSync: true,
        currentStep: metrics.currentStep,
        recordsProcessed: metrics.metrics.recordsProcessed.value,
        pagesProcessed: metrics.metrics.pagesProcessed.value,
        errorsCount: metrics.metrics.errorsCount.value,
        startTime: new Date(metrics.startTime).toISOString(),
        duration: Date.now() - metrics.startTime
    };
}

/**
 * ✅ NOVA FUNÇÃO: Verifica se sincronização de inventário está ativa
 */
function isInventorySyncActive(empresa_id) {
    const stats = getInventoryStats(empresa_id);
    return stats.hasActiveSync;
}

// ===========================
// EXPORTAÇÕES
// ===========================

module.exports = {
    // Função principal (versão completa)
    executeInventorySync,
    
    // Função simplificada (compatibilidade)
    executeSimpleInventorySync,
    
    // Funções auxiliares
    syncEstoqueWithPagination,
    executeInventoryOperations,
    
    // Funções utilitárias
    getInventoryStats,
    isInventorySyncActive
};