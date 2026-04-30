// src/services/stepService.js - VERSÃO MELHORADA E CONSISTENTE
require("dotenv").config();
const supabase = require("./supabaseService");
const { formatDate } = require('../utils/dateUtils');
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
// FUNÇÕES AUXILIARES DE PAGINAÇÃO
// ===========================

/**
 * Função unificada de paginação com logging e métricas integradas
 * Versão melhorada para sincronização first-time
 */
async function syncWithPagination(url, body, empresa_id, refresh_token, useQuantity = false, stepName = 'unknown') {
    let nextPage = 1;
    let quantidade = 100;
    let isPaginationFinished = false;
    let totalRecordsProcessed = 0;
    
    const logger = createSyncContext(empresa_id, 'first-time', stepName);
    const metrics = getSyncMetrics(empresa_id, 'first-time');

    logger.info('Iniciando paginação para sincronização first-time', {
        stepName,
        url: url.split('/').pop(),
        useQuantity,
        startPage: nextPage
    });

    while (!isPaginationFinished) {
        try {
            // Prepara o payload com a página atual
            const payload = { ...body, page: nextPage };
            
            logger.debug('Iniciando requisição de página', {
                stepName,
                page: nextPage,
                useQuantity
            });
            
            // Usa o novo serviço de Edge Function com retry e rate limiting
            const result = await callEdgeFunction(
                url,
                payload,
                empresa_id,
                body.access_token,
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
                syncType: 'first-time'
            });

            // Lógica de paginação dependendo do modo
            if (useQuantity) {
                quantidade = result?.quantidade ?? 0;
                if (quantidade < 100) {
                    logger.info('Paginação finalizada por quantidade', {
                        stepName,
                        quantidade,
                        totalPages: nextPage,
                        totalRecords: totalRecordsProcessed
                    });
                    isPaginationFinished = true;
                } else {
                    nextPage++;
                    logger.debug('Avançando para próxima página', {
                        stepName,
                        nextPage,
                        quantidade
                    });
                }
            } else {
                nextPage = result?.next_page ?? null;
                if (nextPage === null) {
                    logger.info('Paginação finalizada por next_page null', {
                        stepName,
                        totalPages: nextPage || 1,
                        totalRecords: totalRecordsProcessed
                    });
                    isPaginationFinished = true;
                } else {
                    logger.debug('Próxima página identificada', {
                        stepName,
                        nextPage
                    });
                }
            }
            
            // Delay entre páginas (só se ainda tiver mais páginas)
            if (!isPaginationFinished) {
                const delayTime = getDelay('pagination');
                logger.debug('Aplicando delay entre páginas', {
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
                    url: url.split('/').pop()
                });
            }
            
            logError(error, `syncWithPagination-${stepName}`, {
                empresa_id,
                page: nextPage,
                url: url.split('/').pop()
            });
            
            throw error;
        }
    }

    logger.info('Paginação concluída com sucesso', {
        stepName,
        totalRecords: totalRecordsProcessed,
        totalPages: nextPage
    });

    return { totalRecordsProcessed, totalPages: nextPage };
}

// ===========================
// ETAPA 1: PRODUTOS E DETALHES
// ===========================

async function etapaProdutos(empresa_id, accessToken, refresh_token, paginaAtual = 1) {
    const stepName = 'produtos';
    const logger = createSyncContext(empresa_id, 'first-time', stepName);
    const metrics = getSyncMetrics(empresa_id, 'first-time');

    logOperationStart(`firstTime-${stepName}`, { empresa_id, paginaAtual });
    
    if (metrics) {
        metrics.startStep(stepName);
    }

    try {
        logger.info('Iniciando sincronização de produtos e detalhes', {
            stepName,
            paginaAtual,
            totalSubSteps: 2
        });

        // Sub-etapa 1.1: Sincronizar produtos usando quantidade (< 100 para encerrar)
        logger.info('Sub-etapa 1.1: Sincronizando produtos', { stepName });
        
        const produtosResult = await syncWithPagination(
            `${process.env.SUPABASE_URL}/functions/v1/sync_prod_2`,
            { 
                empresa_id: Number(empresa_id), 
                access_token: accessToken, 
                page: paginaAtual 
            },
            empresa_id, 
            refresh_token, 
            true, // ✅ Controla paginação usando 'quantidade'
            `${stepName}-sync`
        );

        logger.info('Sub-etapa 1.1 concluída', {
            stepName,
            totalRecords: produtosResult.totalRecordsProcessed,
            totalPages: produtosResult.totalPages
        });

        // Delay entre sub-etapas
        const miniDelayTime = getDelay('steps', 'mini');
        logger.debug('Delay entre sub-etapas', {
            stepName,
            delayTime: `${miniDelayTime}ms`
        });
        await delay(miniDelayTime);

        // Sub-etapa 1.2: Sincronizar detalhes do produto usando next_page
        logger.info('Sub-etapa 1.2: Sincronizando detalhes dos produtos', { stepName });
        
        const detalhesResult = await syncWithPagination(
            `${process.env.SUPABASE_URL}/functions/v1/sync_detalhes_prod`,
            { 
                empresa_id: Number(empresa_id), 
                access_token: accessToken 
            },
            empresa_id, 
            refresh_token, 
            false, // ✅ Controla paginação usando 'next_page'
            `${stepName}-detalhes`
        );

        logger.info('Sub-etapa 1.2 concluída', {
            stepName,
            totalRecords: detalhesResult.totalRecordsProcessed,
            totalPages: detalhesResult.totalPages
        });

        const finalStats = {
            produtos: produtosResult,
            detalhes: detalhesResult,
            totalRecords: produtosResult.totalRecordsProcessed + detalhesResult.totalRecordsProcessed
        };

        if (metrics) {
            metrics.endStep('completed');
        }

        logOperationEnd(`firstTime-${stepName}`, true, {
            empresa_id,
            ...finalStats
        });

        logger.info('Etapa de produtos concluída com sucesso', {
            stepName,
            ...finalStats
        });

        return finalStats;

    } catch (error) {
        if (metrics) {
            metrics.recordError(error, { stepName });
            metrics.endStep('failed');
        }

        logOperationEnd(`firstTime-${stepName}`, false, {
            empresa_id,
            error: error.message
        });

        logError(error, `firstTime-${stepName}`, { empresa_id, paginaAtual });
        throw error;
    }
}

// ===========================
// ETAPA 2: FORNECEDORES E DETALHES
// ===========================

async function etapaFornecedores(empresa_id, accessToken, refresh_token) {
    const stepName = 'fornecedores';
    const logger = createSyncContext(empresa_id, 'first-time', stepName);
    const metrics = getSyncMetrics(empresa_id, 'first-time');

    logOperationStart(`firstTime-${stepName}`, { empresa_id });
    
    if (metrics) {
        metrics.startStep(stepName);
    }

    try {
        logger.info('Iniciando sincronização de fornecedores e detalhes', {
            stepName,
            totalSubSteps: 2
        });

        // Sub-etapa 2.1: Sincroniza fornecedores por produto
        logger.info('Sub-etapa 2.1: Sincronizando fornecedores por produto', { stepName });
        
        const fornecedoresResult = await syncWithPagination(
            `${process.env.SUPABASE_URL}/functions/v1/sync_fornecedor_by_productID`,
            { 
                empresa_id: Number(empresa_id), 
                access_token: accessToken 
            },
            empresa_id, 
            refresh_token,
            false,
            `${stepName}-sync`
        );

        logger.info('Sub-etapa 2.1 concluída', {
            stepName,
            totalRecords: fornecedoresResult.totalRecordsProcessed
        });

        // Delay entre sub-etapas
        const miniDelayTime = getDelay('steps', 'mini');
        await delay(miniDelayTime);
        
        // Sub-etapa 2.2: Sincroniza detalhes dos fornecedores
        logger.info('Sub-etapa 2.2: Sincronizando detalhes dos fornecedores', { stepName });
        
        const detalhesResult = await syncWithPagination(
            `${process.env.SUPABASE_URL}/functions/v1/detalhes_fornecedor`,
            { 
                empresa_id: Number(empresa_id), 
                access_token: accessToken 
            },
            empresa_id, 
            refresh_token,
            false,
            `${stepName}-detalhes`
        );

        logger.info('Sub-etapa 2.2 concluída', {
            stepName,
            totalRecords: detalhesResult.totalRecordsProcessed
        });

        const finalStats = {
            fornecedores: fornecedoresResult,
            detalhes: detalhesResult,
            totalRecords: fornecedoresResult.totalRecordsProcessed + detalhesResult.totalRecordsProcessed
        };

        if (metrics) {
            metrics.endStep('completed');
        }

        logOperationEnd(`firstTime-${stepName}`, true, {
            empresa_id,
            ...finalStats
        });

        logger.info('Etapa de fornecedores concluída com sucesso', {
            stepName,
            ...finalStats
        });

        return finalStats;

    } catch (error) {
        if (metrics) {
            metrics.recordError(error, { stepName });
            metrics.endStep('failed');
        }

        logOperationEnd(`firstTime-${stepName}`, false, {
            empresa_id,
            error: error.message
        });

        logError(error, `firstTime-${stepName}`, { empresa_id });
        throw error;
    }
}

// ===========================
// ETAPA 3: PEDIDOS DE VENDA E DETALHES
// ===========================

async function etapaPedidosVenda(empresa_id, accessToken, refresh_token) {
    const stepName = 'pedidos-venda';
    const logger = createSyncContext(empresa_id, 'first-time', stepName);
    const metrics = getSyncMetrics(empresa_id, 'first-time');

    logOperationStart(`firstTime-${stepName}`, { empresa_id });
    
    if (metrics) {
        metrics.startStep(stepName);
    }

    try {
        const currentDate = new Date();
        const oneYearAgo = new Date(currentDate);
        oneYearAgo.setFullYear(currentDate.getFullYear() - SYNC.FIRST_TIME_PERIOD_MONTHS / 12);

        logger.info('Iniciando sincronização de pedidos de venda e detalhes', {
            stepName,
            periodo: `${formatDate(oneYearAgo)} até ${formatDate(currentDate)}`,
            totalSubSteps: 2
        });

        // Sub-etapa 3.1: Loop de sincronização diária de pedidos de venda
        logger.info('Sub-etapa 3.1: Sincronizando pedidos de venda por dia', { stepName });
        
        let iterationDate = new Date(currentDate);
        let totalDaysProcessed = 0;

        while (iterationDate >= oneYearAgo) {
            const data_dia = iterationDate.toISOString().split('T')[0];
            
            try {
                logger.debug('Sincronizando pedidos do dia', {
                    stepName,
                    data_dia,
                    dayNumber: totalDaysProcessed + 1
                });
                
                const result = await callEdgeFunction(
                    `${process.env.SUPABASE_URL}/functions/v1/sync_pedido_venda`,
                    { data_dia },
                    empresa_id,
                    accessToken,
                    refresh_token,
                    { context: 'default' }
                );
                
                totalDaysProcessed++;
                
                if (metrics) {
                    const recordCount = result?.recordsProcessed || 0;
                    metrics.recordsProcessed(recordCount);
                }

                logger.debug('Dia sincronizado com sucesso', {
                    stepName,
                    data_dia,
                    dayNumber: totalDaysProcessed,
                    recordsProcessed: result?.recordsProcessed || 0
                });

            } catch (error) {
                if (metrics) {
                    metrics.recordError(error, { stepName, data_dia });
                }

                logger.warn('Falha ao sincronizar dia específico', {
                    stepName,
                    data_dia,
                    error: error.message
                });
                // Continua para o próximo dia mesmo em caso de erro
            }

            iterationDate.setDate(iterationDate.getDate() - 1);
            
            const dayDelayTime = getDelay('days');
            await delay(dayDelayTime);
        }

        logger.info('Sub-etapa 3.1 concluída', {
            stepName,
            totalDaysProcessed
        });

        // Delay entre sub-etapas
        const miniDelayTime = getDelay('steps', 'mini');
        await delay(miniDelayTime);

        // Sub-etapa 3.2: Loop de sincronização de detalhes dos pedidos de venda
        logger.info('Sub-etapa 3.2: Sincronizando detalhes dos pedidos de venda', { stepName });
        
        const detalhesResult = await syncWithPagination(
            `${process.env.SUPABASE_URL}/functions/v1/detalhes_pedido_venda`,
            { 
                empresa_id: Number(empresa_id), 
                access_token: accessToken 
            },
            empresa_id, 
            refresh_token,
            false,
            `${stepName}-detalhes`
        );

        logger.info('Sub-etapa 3.2 concluída', {
            stepName,
            totalRecords: detalhesResult.totalRecordsProcessed
        });

        const finalStats = {
            daysProcessed: totalDaysProcessed,
            detalhes: detalhesResult,
            totalRecords: detalhesResult.totalRecordsProcessed
        };

        if (metrics) {
            metrics.endStep('completed');
        }

        logOperationEnd(`firstTime-${stepName}`, true, {
            empresa_id,
            ...finalStats
        });

        logger.info('Etapa de pedidos de venda concluída com sucesso', {
            stepName,
            ...finalStats
        });

        return finalStats;

    } catch (error) {
        if (metrics) {
            metrics.recordError(error, { stepName });
            metrics.endStep('failed');
        }

        logOperationEnd(`firstTime-${stepName}`, false, {
            empresa_id,
            error: error.message
        });

        logError(error, `firstTime-${stepName}`, { empresa_id });
        throw error;
    }
}

// ===========================
// ETAPA 4: PEDIDOS DE COMPRA E DETALHES
// ===========================

async function etapaPedidosCompra(empresa_id, accessToken, refresh_token) {
    const stepName = 'pedidos-compra';
    const logger = createSyncContext(empresa_id, 'first-time', stepName);
    const metrics = getSyncMetrics(empresa_id, 'first-time');

    logOperationStart(`firstTime-${stepName}`, { empresa_id });
    
    if (metrics) {
        metrics.startStep(stepName);
    }

    try {
        logger.info('Iniciando sincronização de pedidos de compra e detalhes', {
            stepName,
            totalSubSteps: 3
        });

        // Busca fornecedores no Supabase
        const { data: fornecedoresList, error } = await supabase
            .from("fornecedores")
            .select("id_bling")
            .eq("empresa_id", Number(empresa_id))
            .not("id_bling", "is", null);

        if (error) throw error;

        logger.info('Fornecedores encontrados para sincronização', {
            stepName,
            totalFornecedores: fornecedoresList.length
        });

        // Sub-etapa 4.1: Loop para sincronizar pedidos de compra por fornecedor
        logger.info('Sub-etapa 4.1: Sincronizando pedidos de compra por fornecedor', { stepName });
        
        let processedSuppliers = 0;
        let skippedSuppliers = 0;

        for (const [index, forn] of fornecedoresList.entries()) {
            if (forn.id_bling === 0) {
                skippedSuppliers++;
                logger.warn('Fornecedor ignorado - ID inválido', {
                    stepName,
                    supplierIndex: index + 1,
                    totalSuppliers: fornecedoresList.length,
                    id_bling: forn.id_bling
                });
                continue;
            }

            try {
                await callEdgeFunction(
                    `${process.env.SUPABASE_URL}/functions/v1/sync_pedido_compra`,
                    { id_bling_fornecedor: forn.id_bling },
                    empresa_id,
                    accessToken,
                    refresh_token,
                    { context: 'default' }
                );
                
                processedSuppliers++;
                
                if (metrics) {
                    metrics.recordsProcessed(1); // 1 fornecedor processado
                }

                logger.debug('Fornecedor sincronizado', {
                    stepName,
                    supplierIndex: index + 1,
                    totalSuppliers: fornecedoresList.length,
                    id_bling: forn.id_bling
                });

            } catch (error) {
                if (metrics) {
                    metrics.recordError(error, {
                        stepName,
                        id_bling_fornecedor: forn.id_bling
                    });
                }

                logger.warn('Erro ao sincronizar fornecedor', {
                    stepName,
                    id_bling: forn.id_bling,
                    error: error.message
                });
                // Continua para o próximo fornecedor mesmo em caso de erro
            }

            const supplierDelayTime = getDelay('suppliers');
            await delay(supplierDelayTime);
        }

        logger.info('Sub-etapa 4.1 concluída', {
            stepName,
            processedSuppliers,
            skippedSuppliers,
            totalSuppliers: fornecedoresList.length
        });

        // Delay entre sub-etapas
        const miniDelayTime = getDelay('steps', 'mini');
        await delay(miniDelayTime);

        // Sub-etapa 4.2: Sincronização de detalhes dos pedidos de compra
        logger.info('Sub-etapa 4.2: Sincronizando detalhes de pedidos de compra', { stepName });
        
        const detalhesResult = await syncWithPagination(
            `${process.env.SUPABASE_URL}/functions/v1/detalhes_pedido_compra`,
            { 
                empresa_id: Number(empresa_id), 
                access_token: accessToken 
            },
            empresa_id, 
            refresh_token,
            false,
            `${stepName}-detalhes`
        );

        logger.info('Sub-etapa 4.2 concluída', {
            stepName,
            totalRecords: detalhesResult.totalRecordsProcessed
        });

        await delay(miniDelayTime);

        // Sub-etapa 4.3: Sincronização das últimas compras
        logger.info('Sub-etapa 4.3: Sincronizando últimas compras', { stepName });
        
        const ultimasComprasResult = await syncWithPagination(
            `${process.env.SUPABASE_URL}/functions/v1/sincronizar_ultimas_compras`,
            { 
                empresa_id: Number(empresa_id), 
                access_token: accessToken 
            },
            empresa_id, 
            refresh_token,
            false,
            `${stepName}-ultimas`
        );

        logger.info('Sub-etapa 4.3 concluída', {
            stepName,
            totalRecords: ultimasComprasResult.totalRecordsProcessed
        });

        const finalStats = {
            processedSuppliers,
            skippedSuppliers,
            detalhes: detalhesResult,
            ultimasCompras: ultimasComprasResult,
            totalRecords: detalhesResult.totalRecordsProcessed + ultimasComprasResult.totalRecordsProcessed
        };

        if (metrics) {
            metrics.endStep('completed');
        }

        logOperationEnd(`firstTime-${stepName}`, true, {
            empresa_id,
            ...finalStats
        });

        logger.info('Etapa de pedidos de compra concluída com sucesso', {
            stepName,
            ...finalStats
        });

        return finalStats;

    } catch (error) {
        if (metrics) {
            metrics.recordError(error, { stepName });
            metrics.endStep('failed');
        }

        logOperationEnd(`firstTime-${stepName}`, false, {
            empresa_id,
            error: error.message
        });

        logError(error, `firstTime-${stepName}`, { empresa_id });
        throw error;
    }
}

// ===========================
// ETAPA 5: FLUXO DE NOTAS FISCAIS
// ===========================

async function etapaNotasFiscais(empresa_id, accessToken, refresh_token) {
    const stepName = 'notas-fiscais';
    const logger = createSyncContext(empresa_id, 'first-time', stepName);
    const metrics = getSyncMetrics(empresa_id, 'first-time');

    logOperationStart(`firstTime-${stepName}`, { empresa_id });
    
    if (metrics) {
        metrics.startStep(stepName);
    }

    try {
        const currentDate = new Date();
        const oneYearAgo = new Date(currentDate);
        oneYearAgo.setFullYear(currentDate.getFullYear() - SYNC.FIRST_TIME_PERIOD_MONTHS / 12);

        logger.info('Iniciando sincronização do fluxo de notas fiscais', {
            stepName,
            periodo: `${formatDate(oneYearAgo)} até ${formatDate(currentDate)}`,
            totalSubSteps: 7
        });

        // Sub-etapa 5.1: Loop de sincronização mensal de últimas compras
        logger.info('Sub-etapa 5.1: Sincronizando últimas compras por mês', { stepName });
        
        let iterationDate = new Date(currentDate);
        let totalMonthsProcessed = 0;

        while (iterationDate >= oneYearAgo) {
            const startDate = new Date(iterationDate);
            startDate.setDate(1); // Início do mês
            const endDate = new Date(iterationDate);
            endDate.setDate(new Date(endDate.getFullYear(), endDate.getMonth() + 1, 0).getDate()); // Fim do mês

            try {
                await callEdgeFunction(
                    `${process.env.SUPABASE_URL}/functions/v1/sincronizar_ultimas_compras`,
                    {
                        start_date: formatDate(startDate),
                        end_date: formatDate(endDate)
                    },
                    empresa_id,
                    accessToken,
                    refresh_token,
                    { context: 'default' }
                );
                
                totalMonthsProcessed++;
                
                if (metrics) {
                    metrics.recordsProcessed(1); // 1 mês processado
                }

                logger.debug('Mês sincronizado', {
                    stepName,
                    mes: formatDate(startDate),
                    monthNumber: totalMonthsProcessed
                });

            } catch (error) {
                if (metrics) {
                    metrics.recordError(error, { stepName, mes: formatDate(startDate) });
                }

                logger.warn('Erro ao sincronizar mês específico', {
                    stepName,
                    mes: formatDate(startDate),
                    error: error.message
                });
                // Continua para o próximo mês mesmo em caso de erro
            }

            const monthDelayTime = getDelay('months');
            await delay(monthDelayTime);
            iterationDate.setMonth(iterationDate.getMonth() - 1); // Retrocede um mês
        }

        logger.info('Sub-etapa 5.1 concluída', {
            stepName,
            totalMonthsProcessed
        });

        // Sub-etapa 5.2: Sincronização de detalhes das notas fiscais
        logger.info('Sub-etapa 5.2: Sincronizando detalhes das notas fiscais', { stepName });
        
        const detalhesNotasResult = await syncWithPagination(
            `${process.env.SUPABASE_URL}/functions/v1/detalhes_nota_fiscal`,
            { 
                empresa_id: Number(empresa_id), 
                access_token: accessToken 
            },
            empresa_id, 
            refresh_token,
            false,
            `${stepName}-detalhes`
        );

        logger.info('Sub-etapa 5.2 concluída', {
            stepName,
            totalRecords: detalhesNotasResult.totalRecordsProcessed
        });

        const afterDelayTime = getDelay('pagination');
        await delay(afterDelayTime);

        // Sub-etapa 5.3: Loop de sincronização de notas fiscais por chave de acesso
        logger.info('Sub-etapa 5.3: Sincronizando notas fiscais por chave de acesso', { stepName });
        
        const { data: chavesList, error } = await supabase
            .from("notas_fiscais")
            .select("chave_acesso")
            .eq("empresa_id", Number(empresa_id))
            .not("chave_acesso", "is", null);

        if (error) throw error;

        logger.info('Chaves de acesso encontradas', {
            stepName,
            totalChaves: chavesList?.length || 0
        });

        let processedNotes = 0;
        let erroredNotes = 0;

        for (const [index, nota] of (chavesList || []).entries()) {
            try {
                await callEdgeFunction(
                    `${process.env.SUPABASE_URL}/functions/v1/detalhes_nota_fiscal_chave_acesso_v2`,
                    { chave_acesso: nota.chave_acesso, empresa_id: Number(empresa_id) },
                    empresa_id,
                    accessToken,
                    refresh_token,
                    { 
                        context: 'notes',
                        maxRetries: 5 
                    }
                );
                
                processedNotes++;
                
                if (metrics) {
                    metrics.recordsProcessed(1);
                }

                if (index % 10 === 0 && index > 0) {
                    logger.debug('Progresso de sincronização de notas', {
                        stepName,
                        processedNotes: index + 1,
                        totalNotes: chavesList.length,
                        progressPercent: Math.round(((index + 1) / chavesList.length) * 100)
                    });
                }
                
            } catch (error) {
                erroredNotes++;
                
                if (metrics) {
                    metrics.recordError(error, {
                        stepName,
                        chave_acesso: nota.chave_acesso.substring(0, 10)
                    });
                }

                logger.warn('Erro ao sincronizar nota fiscal', {
                    stepName,
                    chave_preview: nota.chave_acesso.substring(0, 10),
                    error: error.message
                });
            }
            
            await delay(500);
            
            // Pausa extra a cada lote de notas
            if (index % SYNC.NOTES_BATCH_SIZE === (SYNC.NOTES_BATCH_SIZE - 1)) {
                const batchDelayTime = getDelay('pagination', 'notes');
                logger.debug('Pausa entre lotes de notas', {
                    stepName,
                    batchNumber: Math.floor(index / SYNC.NOTES_BATCH_SIZE) + 1,
                    delayTime: `${batchDelayTime}ms`
                });
                await delay(batchDelayTime);
            }
        }

        logger.info('Sub-etapa 5.3 concluída', {
            stepName,
            processedNotes,
            erroredNotes,
            totalNotes: chavesList?.length || 0
        });

        // Sub-etapa 5.4: Detalhamento de Produtos via API Externa
        logger.info('Sub-etapa 5.4: Detalhamento de produtos via EAN', { stepName });
        
        try {
            await callEdgeFunction(
                `${process.env.VALIDACAO_EAN_URL}/detalhamento_de_produtos/`,
                {
                    webhook_url: process.env.WEBHOOK_URL,
                    data_inicio: formatDate(oneYearAgo),
                    data_fim: formatDate(currentDate)
                },
                empresa_id,
                accessToken,
                refresh_token,
                { 
                    context: 'external',
                    headers: { "Content-Type": "application/json" },
                    maxRetries: 3 
                }
            );
            
            logger.info('Sub-etapa 5.4 concluída com sucesso', { stepName });
            
        } catch (error) {
            if (metrics) {
                metrics.recordError(error, { stepName, operation: 'detalhamento_produtos' });
            }
            logger.warn('Erro no detalhamento de produtos', {
                stepName,
                error: error.message
            });
        }

        // Sub-etapa 5.5: Vínculo de Produtos por Fornecedor
        logger.info('Sub-etapa 5.5: Vínculo de produtos por fornecedor', { stepName });
        
        try {
            await callEdgeFunction(
                `${process.env.VALIDACAO_EAN_URL}/vinculo_produto_por_fornecedor/`,
                { webhook_url: process.env.WEBHOOK_URL_VINCULO },
                empresa_id,
                accessToken,
                refresh_token,
                { 
                    context: 'external',
                    headers: { "Content-Type": "application/json" },
                    maxRetries: 3 
                }
            );
            
            logger.info('Sub-etapa 5.5 concluída com sucesso', { stepName });
            
        } catch (error) {
            if (metrics) {
                metrics.recordError(error, { stepName, operation: 'vinculo_produtos' });
            }
            logger.warn('Erro no vínculo de produtos', {
                stepName,
                error: error.message
            });
        }

        // Sub-etapa 5.6: Sincronização de estoque
        logger.info('Sub-etapa 5.6: Sincronizando estoque', { stepName });
        
        const estoqueResult = await syncWithPagination(
            `${process.env.SUPABASE_URL}/functions/v1/sync_estoque`,
            { 
                empresa_id: Number(empresa_id), 
                access_token: accessToken 
            },
            empresa_id, 
            refresh_token,
            false,
            `${stepName}-estoque`
        );

        logger.info('Sub-etapa 5.6 concluída', {
            stepName,
            totalRecords: estoqueResult.totalRecordsProcessed
        });

        const miniDelayTime = getDelay('steps', 'mini');
        await delay(miniDelayTime);

        // Sub-etapa 5.7: Sincronização de formas de pagamento dos pedidos de compra
        logger.info('Sub-etapa 5.7: Sincronizando formas de pagamento', { stepName });
        
        const formasPagamentoResult = await syncWithPagination(
            `${process.env.SUPABASE_URL}/functions/v1/sync_formas_de_pagamento_pedidos_de_compra`,
            { 
                empresa_id: Number(empresa_id), 
                access_token: accessToken 
            },
            empresa_id, 
            refresh_token,
            false,
            `${stepName}-pagamentos`
        );

        logger.info('Sub-etapa 5.7 concluída', {
            stepName,
            totalRecords: formasPagamentoResult.totalRecordsProcessed
        });

        const finalStats = {
            totalMonthsProcessed,
            detalhesNotas: detalhesNotasResult,
            processedNotes,
            erroredNotes,
            estoque: estoqueResult,
            formasPagamento: formasPagamentoResult,
            totalRecords: detalhesNotasResult.totalRecordsProcessed + 
                          processedNotes + 
                          estoqueResult.totalRecordsProcessed + 
                          formasPagamentoResult.totalRecordsProcessed
        };

        if (metrics) {
            metrics.endStep('completed');
        }

        logOperationEnd(`firstTime-${stepName}`, true, {
            empresa_id,
            ...finalStats
        });

        logger.info('Etapa de notas fiscais concluída com sucesso', {
            stepName,
            ...finalStats
        });

        return finalStats;

    } catch (error) {
        if (metrics) {
            metrics.recordError(error, { stepName });
            metrics.endStep('failed');
        }

        logOperationEnd(`firstTime-${stepName}`, false, {
            empresa_id,
            error: error.message
        });

        logError(error, `firstTime-${stepName}`, { empresa_id });
        throw error;
    }
}

// ===========================
// FUNÇÃO PRINCIPAL
// ===========================

async function executeSteps(empresa_id, accessToken, refresh_token, paginaAtual = 1) {
    const logger = createSyncContext(empresa_id, 'first-time', 'main-flow');
    const metrics = getSyncMetrics(empresa_id, 'first-time');

    logOperationStart('executeSteps', { empresa_id, paginaAtual });

    try {
        logger.info('Iniciando sincronização completa em etapas', {
            empresa_id,
            paginaAtual,
            totalSteps: 5
        });
        
        // Obtém um token válido
        const token = await getValidBlingToken(Number(empresa_id), accessToken, refresh_token);
        
        logger.info('Token válido obtido para sincronização', {
            tokenPreview: `${token.substring(0, 8)}***`
        });
        
        // Executa as etapas sequencialmente
        const steps = [
            { 
                name: 'Produtos', 
                fn: () => etapaProdutos(empresa_id, token, refresh_token, paginaAtual) 
            },
            { 
                name: 'Fornecedores', 
                fn: () => etapaFornecedores(empresa_id, token, refresh_token) 
            },
            { 
                name: 'Pedidos de Venda', 
                fn: () => etapaPedidosVenda(empresa_id, token, refresh_token) 
            },
            { 
                name: 'Pedidos de Compra', 
                fn: () => etapaPedidosCompra(empresa_id, token, refresh_token) 
            },
            { 
                name: 'Notas Fiscais', 
                fn: () => etapaNotasFiscais(empresa_id, token, refresh_token) 
            }
        ];

        const stepResults = [];
        let totalProcessedRecords = 0;

        for (let i = 0; i < steps.length; i++) {
            const step = steps[i];
            const stepNumber = i + 1;
            
            try {
                logger.info(`Iniciando etapa ${stepNumber}/5: ${step.name}`, {
                    stepName: step.name,
                    stepNumber,
                    totalSteps: steps.length
                });

                const stepResult = await step.fn();
                stepResults.push({
                    stepName: step.name,
                    stepNumber,
                    success: true,
                    ...stepResult
                });

                // Acumula total de registros processados
                totalProcessedRecords += stepResult?.totalRecords || 0;

                logger.info(`Etapa ${stepNumber}/5 concluída: ${step.name}`, {
                    stepName: step.name,
                    stepNumber,
                    totalRecords: stepResult.totalRecords
                });

                // Delay entre etapas (exceto na última)
                if (i < steps.length - 1) {
                    const stepDelayTime = getDelay('steps');
                    logger.info(`Aguardando ${stepDelayTime/1000}s antes da próxima etapa...`, {
                        currentStep: step.name,
                        nextStep: steps[i + 1].name
                    });
                    await delay(stepDelayTime);
                }

            } catch (error) {
                stepResults.push({
                    stepName: step.name,
                    stepNumber,
                    success: false,
                    error: error.message
                });

                logger.error(`Erro na etapa ${stepNumber}/5: ${step.name}`, {
                    stepName: step.name,
                    stepNumber,
                    error: error.message
                });
                
                // Para a execução em caso de erro
                throw error;
            }
        }

        const finalResult = {
            success: true,
            message: "Sincronização completa concluída com sucesso",
            empresa_id: Number(empresa_id),
            paginaAtual,
            totalSteps: steps.length,
            totalRecords: totalProcessedRecords,
            stepResults,
            ...(metrics && {
                metrics: metrics.getReport()
            })
        };

        logOperationEnd('executeSteps', true, {
            empresa_id,
            totalRecords: totalProcessedRecords,
            totalSteps: steps.length
        });

        logger.info('Sincronização completa concluída com sucesso', {
            totalSteps: steps.length,
            totalRecords: totalProcessedRecords,
            duration: metrics ? `${Date.now() - metrics.startTime}ms` : 'N/A'
        });

        return finalResult;

    } catch (error) {
        const errorResult = {
            success: false,
            message: "Erro durante a sincronização completa",
            error: error.message || "Erro desconhecido",
            empresa_id: Number(empresa_id),
            paginaAtual,
            ...(metrics && {
                metrics: metrics.getReport()
            })
        };

        logOperationEnd('executeSteps', false, {
            empresa_id,
            error: error.message
        });

        logError(error, 'executeSteps', {
            empresa_id,
            paginaAtual
        });

        return errorResult;
    }
}

// ===========================
// FUNÇÃO AUXILIAR PARA EXECUÇÃO POR ETAPA ESPECÍFICA
// ===========================

/**
 * Executa steps a partir de uma etapa específica
 * ✅ NOVA FUNÇÃO: Para suporte ao syncService melhorado
 */
async function executeStepsFromSpecificStep(empresa_id, accessToken, refresh_token, paginaAtual, startFromStep) {
    const logger = createSyncContext(empresa_id, 'first-time', `from-${startFromStep}`);
    const metrics = getSyncMetrics(empresa_id, 'first-time');
    
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
        const stepResults = [];
        let totalProcessedRecords = 0;
        
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
                const stepResult = await stepFunctions[stepName]();
                stepResults.push({
                    stepName,
                    stepNumber,
                    success: true,
                    ...stepResult
                });

                totalProcessedRecords += stepResult?.totalRecords || 0;
                
                logger.info(`Etapa ${stepNumber}/5 concluída: ${stepName}`, {
                    stepName,
                    stepNumber,
                    totalRecords: stepResult?.totalRecords || 0
                });

                // Delay entre etapas (exceto na última)
                if (i < stepsToExecute.length - 1) {
                    const delayTime = getDelay('steps');
                    logger.info(`Aguardando ${delayTime/1000}s antes da próxima etapa...`);
                    await delay(delayTime);
                }

            } catch (error) {
                stepResults.push({
                    stepName,
                    stepNumber,
                    success: false,
                    error: error.message
                });

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
            stepsExecuted: stepsToExecute,
            totalRecords: totalProcessedRecords
        });

        return { 
            success: true, 
            message: `Sincronização first-time concluída a partir da etapa '${startFromStep}'`,
            startFromStep,
            stepsExecuted: stepsToExecute,
            totalStepsExecuted: stepsToExecute.length,
            totalRecords: totalProcessedRecords,
            stepResults,
            ...(metrics && {
                metrics: metrics.getReport()
            })
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
            startFromStep,
            ...(metrics && {
                metrics: metrics.getReport()
            })
        };
    }
}

// ===========================
// EXPORTAÇÕES
// ===========================

module.exports = {
    // Função principal (compatibilidade mantida)
    executeSteps,
    
    // ✅ NOVA FUNÇÃO: Para execução a partir de etapa específica
    executeStepsFromSpecificStep,
    
    // Funções individuais das etapas (para uso no syncService)
    etapaProdutos,
    etapaFornecedores,
    etapaPedidosVenda,
    etapaPedidosCompra,
    etapaNotasFiscais,
    
    // Função auxiliar
    syncWithPagination
};