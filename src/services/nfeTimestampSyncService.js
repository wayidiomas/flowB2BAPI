// src/services/nfeTimestampSyncService.js
require("dotenv").config();
const { getDelay, getRetryConfig, SYNC } = require("../config/SyncConfig");
const delay = require("../utils/delay");
const { getValidBlingToken } = require("./blingTokenService");
const { callEdgeFunction } = require("./edgeFunctionService");
const { getSyncMetrics } = require("./metricsService");
const supabaseService = require("./supabaseService");
const {
    createSyncContext,
    logOperationStart,
    logOperationEnd,
    logError,
    logPaginationProgress
} = require("../utils/logger");

// Configuracoes do sync
const BATCH_SIZE = 50; // Quantidade de pedidos por batch
const DELAY_BETWEEN_BATCHES = 2000; // 2 segundos entre batches

/**
 * Busca pedidos de venda pendentes de sync de timestamp
 * (pedidos com nota_fiscal_id que ainda nao estao na tabela pedido_venda_timestamp)
 */
async function getPedidosPendentesTimestamp(empresaId, limit = 100) {
    const { data, error } = await supabaseService.executeQuery(async (client) => {
        return client.rpc('get_pedidos_pendentes_timestamp', {
            p_empresa_id: empresaId,
            p_limit: limit
        });
    });

    if (error) {
        throw new Error(`Erro ao buscar pedidos pendentes: ${error.message}`);
    }

    return data || [];
}

/**
 * Sincroniza timestamps de NFe em batches
 */
async function syncNfeTimestampBatch(empresa_id, access_token, pedidos) {
    const logger = createSyncContext(empresa_id, 'nfe-timestamp', 'batch');

    logger.debug('Processando batch de timestamps de NFe', {
        batchSize: pedidos.length,
        pedidoIds: pedidos.map(p => p.pedido_id).slice(0, 5)
    });

    // Chama a Edge Function com o batch de pedidos
    // NOTA: A RPC retorna pedido_id e nota_fiscal_id, mas a Edge Function espera pedido_venda_id e nfe_bling_id
    const result = await callEdgeFunction(
        `${process.env.SUPABASE_URL}/functions/v1/sync_nfe_timestamp`,
        {
            empresa_id: Number(empresa_id),
            access_token,
            pedidos: pedidos.map(p => ({
                pedido_venda_id: p.pedido_id,        // RPC retorna pedido_id
                nfe_bling_id: p.nota_fiscal_id       // RPC retorna nota_fiscal_id
            }))
        },
        empresa_id,
        access_token,
        null, // refresh_token nao necessario aqui
        {
            context: 'notes',
            maxRetries: 10,
            initialDelay: 2000,
            backoffFactor: 1.5
        }
    );

    return result;
}

/**
 * Sincronizacao completa de timestamps de NFe para uma empresa
 */
async function syncNfeTimestamps(empresa_id, access_token, refresh_token) {
    let totalRecordsProcessed = 0;
    let totalBatchesProcessed = 0;
    let totalErrors = 0;
    let hasMorePedidos = true;

    const stepName = 'nfe-timestamp';
    const logger = createSyncContext(empresa_id, 'nfe-timestamp', stepName);
    const metrics = getSyncMetrics(empresa_id, 'nfe-timestamp');

    logger.info('Iniciando sincronizacao de timestamps de NFe', {
        stepName,
        batchSize: BATCH_SIZE
    });

    while (hasMorePedidos) {
        try {
            // Busca pedidos pendentes
            logger.debug('Buscando pedidos pendentes de timestamp', { stepName });

            const pedidosPendentes = await getPedidosPendentesTimestamp(empresa_id, BATCH_SIZE);

            if (pedidosPendentes.length === 0) {
                logger.info('Nenhum pedido pendente encontrado', { stepName });
                hasMorePedidos = false;
                break;
            }

            logger.info('Pedidos pendentes encontrados', {
                stepName,
                count: pedidosPendentes.length
            });

            // Processa o batch
            const result = await syncNfeTimestampBatch(empresa_id, access_token, pedidosPendentes);

            // Conta resultados (Edge Function retorna: success, errors, results)
            totalBatchesProcessed++;
            totalRecordsProcessed += result?.success || 0;
            totalErrors += result?.errors || 0;

            // Registra progresso nas metricas
            if (metrics) {
                metrics.pageProcessed(totalBatchesProcessed, result?.success || 0);
            }

            // Log de progresso
            logPaginationProgress(totalBatchesProcessed, totalRecordsProcessed, stepName, {
                empresa_id,
                syncType: 'nfe-timestamp'
            });

            logger.info('Batch de timestamps processado', {
                stepName,
                batch: totalBatchesProcessed,
                recordsInBatch: result?.success || 0,
                errorsInBatch: result?.errors || 0,
                totalRecords: totalRecordsProcessed
            });

            // Verifica se ainda ha mais pedidos
            // Se retornou menos que o batch size, acabou
            if (pedidosPendentes.length < BATCH_SIZE) {
                hasMorePedidos = false;
                logger.info('Ultimo batch processado', {
                    stepName,
                    totalBatches: totalBatchesProcessed,
                    totalRecords: totalRecordsProcessed
                });
            } else {
                // Delay entre batches para nao sobrecarregar a API do Bling
                logger.debug('Aplicando delay entre batches', {
                    stepName,
                    delayTime: `${DELAY_BETWEEN_BATCHES}ms`
                });
                await delay(DELAY_BETWEEN_BATCHES);
            }

        } catch (error) {
            // Registra erro nas metricas
            if (metrics) {
                metrics.recordError(error, {
                    stepName,
                    batch: totalBatchesProcessed,
                    operation: 'sync_nfe_timestamp'
                });
            }

            logError(error, `syncNfeTimestamps`, {
                empresa_id,
                batch: totalBatchesProcessed,
                stepName,
                totalRecordsProcessed
            });

            logger.error('Erro fatal na sincronizacao de timestamps de NFe', {
                stepName,
                batch: totalBatchesProcessed,
                error: error.message,
                totalRecordsProcessed
            });

            throw error;
        }
    }

    logger.info('Sincronizacao de timestamps de NFe concluida com sucesso', {
        stepName,
        totalRecords: totalRecordsProcessed,
        totalBatches: totalBatchesProcessed,
        totalErrors
    });

    return {
        totalRecordsProcessed,
        totalBatches: totalBatchesProcessed,
        totalErrors
    };
}

/**
 * Fluxo principal de sincronizacao de timestamps de NFe
 */
async function executeNfeTimestampSync(empresa_id, access_token, refresh_token) {
    const logger = createSyncContext(empresa_id, 'nfe-timestamp', 'main-flow');
    const metrics = getSyncMetrics(empresa_id, 'nfe-timestamp');

    logOperationStart('executeNfeTimestampSync', { empresa_id });

    if (metrics) {
        metrics.startStep('nfe-timestamp-sync');
    }

    try {
        logger.info('Iniciando sincronizacao de timestamps de NFe', {
            empresa_id,
            operation: 'executeNfeTimestampSync'
        });

        // Obtem um token valido
        const token = await getValidBlingToken(Number(empresa_id), access_token, refresh_token);

        logger.info('Token valido obtido para sincronizacao de timestamps', {
            tokenPreview: `${token.substring(0, 8)}***`
        });

        // Executa a sincronizacao
        const syncResults = await syncNfeTimestamps(empresa_id, token, refresh_token);

        // Calcula estatisticas finais
        const finalStats = {
            success: true,
            message: "Sincronizacao de timestamps de NFe concluida com sucesso",
            empresa_id: Number(empresa_id),
            totalRecords: syncResults.totalRecordsProcessed,
            totalBatches: syncResults.totalBatches,
            totalErrors: syncResults.totalErrors,
            ...(metrics && {
                metricsRecordsProcessed: metrics.metrics.recordsProcessed.value,
                errorsCount: metrics.metrics.errorsCount.value,
                retriesCount: metrics.metrics.retriesCount.value
            })
        };

        if (metrics) {
            metrics.endStep('completed');
        }

        logOperationEnd('executeNfeTimestampSync', true, {
            empresa_id,
            ...finalStats
        });

        logger.info('Sincronizacao de timestamps de NFe concluida com sucesso', {
            ...finalStats,
            duration: metrics ? `${Date.now() - metrics.startTime}ms` : 'N/A'
        });

        return finalStats;

    } catch (error) {
        const errorStats = {
            success: false,
            message: "Erro durante a sincronizacao de timestamps de NFe",
            error: error.message || "Erro desconhecido",
            empresa_id: Number(empresa_id),
            ...(metrics && {
                recordsProcessed: metrics.metrics.recordsProcessed.value,
                errorsCount: metrics.metrics.errorsCount.value,
                duration: Date.now() - metrics.startTime
            })
        };

        if (metrics) {
            metrics.recordError(error, { operation: 'executeNfeTimestampSync' });
            metrics.endStep('failed');
        }

        logOperationEnd('executeNfeTimestampSync', false, {
            empresa_id,
            error: error.message
        });

        logError(error, 'executeNfeTimestampSync', {
            empresa_id,
            ...errorStats
        });

        logger.error('Erro na sincronizacao de timestamps de NFe', {
            error: error.message,
            ...errorStats
        });

        return errorStats;
    }
}

/**
 * Verifica se sincronizacao de timestamps esta ativa
 */
function isNfeTimestampSyncActive(empresa_id) {
    const metrics = getSyncMetrics(empresa_id, 'nfe-timestamp');
    return metrics?.hasActiveSync || false;
}

/**
 * Obtem estatisticas da sincronizacao de timestamps
 */
function getNfeTimestampStats(empresa_id) {
    const metrics = getSyncMetrics(empresa_id, 'nfe-timestamp');

    if (!metrics) {
        return {
            hasActiveSync: false,
            message: 'Nenhuma sincronizacao de timestamps de NFe ativa'
        };
    }

    return {
        hasActiveSync: true,
        currentStep: metrics.currentStep,
        recordsProcessed: metrics.metrics.recordsProcessed.value,
        errorsCount: metrics.metrics.errorsCount.value,
        startTime: new Date(metrics.startTime).toISOString(),
        duration: Date.now() - metrics.startTime
    };
}

// ===========================
// EXPORTACOES
// ===========================

module.exports = {
    // Funcao principal
    executeNfeTimestampSync,

    // Funcoes auxiliares
    syncNfeTimestamps,
    syncNfeTimestampBatch,
    getPedidosPendentesTimestamp,

    // Funcoes utilitarias
    getNfeTimestampStats,
    isNfeTimestampSyncActive
};
