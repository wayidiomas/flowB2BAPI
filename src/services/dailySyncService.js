// src/services/dailySyncService.js - VERSÃO COMPLETAMENTE CORRIGIDA
require("dotenv").config();
const { formatDate } = require("../utils/dateUtils");
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
const supabase = require("./supabaseService");

// =========================
// Funções Auxiliares
// =========================

async function syncWithPagination(url, body, empresa_id, refresh_token, useQuantity = false, stepName = 'unknown') {
    let nextPage = 1;
    let quantidade = 100;
    let isPaginationFinished = false;
    let totalRecordsProcessed = 0;
    
    const logger = createSyncContext(empresa_id, 'daily', stepName);
    const metrics = getSyncMetrics(empresa_id, 'daily');

    logger.info('Iniciando paginação para sincronização diária', {
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
            
            // Usa o novo serviço de Edge Function com retry
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
                syncType: 'daily'
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

    logger.info('Paginação concluída', {
        stepName,
        totalRecords: totalRecordsProcessed,
        totalPages: nextPage
    });

    return { totalRecordsProcessed, totalPages: nextPage };
}

async function syncRecentData(url, body, limit = 100, stepName = 'unknown') {
    let page = 1;
    const allItems = [];
    let totalRecordsProcessed = 0;
    
    const logger = createSyncContext(body.empresa_id, 'daily', stepName);
    const metrics = getSyncMetrics(body.empresa_id, 'daily');

    logger.info('Iniciando sincronização de dados recentes', {
        stepName,
        limit,
        url: url.split('/').pop()
    });

    while (true) {
        try {
            logger.debug('Sincronizando dados recentes', {
                stepName,
                page,
                limit
            });
            
            // Usa o novo serviço de Edge Function com retry
            const data = await callEdgeFunction(
                url,
                { ...body, page },
                body.empresa_id,
                body.access_token,
                body.refresh_token,
                {
                    context: 'default',
                    maxRetries: 20,
                    initialDelay: 2000,
                    backoffFactor: 1.5
                }
            );
            
            const items = data.data || [];
            allItems.push(...items);
            totalRecordsProcessed += items.length;
            
            // Registra progresso nas métricas
            if (metrics) {
                metrics.pageProcessed(page, items.length);
            }

            logger.info('Página de dados recentes processada', {
                stepName,
                page,
                recordsInPage: items.length,
                totalRecords: totalRecordsProcessed,
                url: url.split('/').pop()
            });

            // Encerra o loop se não houver itens na página atual
            if (items.length === 0) {
                logger.info('Sincronização encerrada - nenhum item encontrado', {
                    stepName,
                    totalRecords: totalRecordsProcessed,
                    totalPages: page
                });
                break;
            }

            // Se houver menos itens do que o limite, encerra o loop
            if (items.length < limit) {
                logger.info('Sincronização encerrada - quantidade menor que limite', {
                    stepName,
                    recordsInPage: items.length,
                    limit,
                    totalRecords: totalRecordsProcessed,
                    totalPages: page
                });
                break;
            }

            page++;
            const delayTime = getDelay('pagination');
            await delay(delayTime);
        } catch (error) {
            // Registra erro nas métricas
            if (metrics) {
                metrics.recordError(error, {
                    stepName,
                    page,
                    url: url.split('/').pop()
                });
            }
            
            logError(error, `syncRecentData-${stepName}`, {
                empresa_id: body.empresa_id,
                page,
                url: url.split('/').pop()
            });
            
            break; // Encerra o loop em caso de erro
        }
    }

    logger.info('Sincronização de dados recentes concluída', {
        stepName,
        totalRecords: totalRecordsProcessed,
        totalPages: page
    });

    return { allItems, totalRecordsProcessed, totalPages: page };
}

// =========================
// Steps Diários
// =========================

async function step1_syncUltimosProdutos(empresa_id, access_token, refresh_token) {
    const stepName = 'produtos';
    const logger = createSyncContext(empresa_id, 'daily', stepName);
    const metrics = getSyncMetrics(empresa_id, 'daily');

    logOperationStart(`daily-${stepName}`, { empresa_id });
    
    if (metrics) {
        metrics.startStep(stepName);
    }

    try {
        // Define o intervalo de datas (ontem e hoje)
        const today = new Date();
        const yesterday = new Date(today);
        yesterday.setDate(today.getDate() - SYNC.DAILY_PERIOD_DAYS);

        const data_inicial = formatDate(yesterday);
        const data_final = formatDate(today);

        logger.info('Iniciando sincronização de últimos produtos', {
            stepName,
            data_inicial,
            data_final
        });

        const url = `${process.env.SUPABASE_URL}/functions/v1/sincronizar_ultimos_produtos`;
        const body = { 
            empresa_id: Number(empresa_id), 
            access_token, 
            refresh_token,
            data_inicial, 
            data_final 
        };

        const result = await syncRecentData(url, body, 100, stepName);
        
        // Delay após última requisição
        const delayTime = getDelay('pagination');
        logger.debug('Aplicando delay após última requisição', {
            stepName,
            delayTime: `${delayTime}ms`
        });
        await delay(delayTime);

        if (metrics) {
            metrics.endStep('completed');
        }

        logOperationEnd(`daily-${stepName}`, true, {
            empresa_id,
            totalRecords: result.totalRecordsProcessed,
            totalPages: result.totalPages
        });

        logger.info('Sincronização de produtos concluída', {
            stepName,
            totalRecords: result.totalRecordsProcessed,
            totalPages: result.totalPages
        });

        return {
            totalRecords: result.totalRecordsProcessed,
            totalPages: result.totalPages
        };

    } catch (error) {
        if (metrics) {
            metrics.recordError(error, { stepName });
            metrics.endStep('failed');
        }

        logOperationEnd(`daily-${stepName}`, false, {
            empresa_id,
            error: error.message
        });

        logError(error, `daily-${stepName}`, { empresa_id });
        throw error;
    }
}

async function step2_syncFornecedores(empresa_id, access_token, refresh_token) {
    const stepName = 'fornecedores';
    const logger = createSyncContext(empresa_id, 'daily', stepName);
    const metrics = getSyncMetrics(empresa_id, 'daily');

    logOperationStart(`daily-${stepName}`, { empresa_id });
    
    if (metrics) {
        metrics.startStep(stepName);
    }

    try {
        logger.info('Iniciando sincronização de fornecedores', { stepName });

        // Sincronizar Fornecedores
        logger.info('Sincronizando fornecedores por produto', { stepName });
        
        const fornecedoresResult = await syncWithPagination(
            `${process.env.SUPABASE_URL}/functions/v1/sync_fornecedor_by_productID`,
            { empresa_id: Number(empresa_id), access_token },
            empresa_id, 
            refresh_token,
            false,
            `${stepName}-sync`
        );

        // Sincronizar Detalhes dos Fornecedores
        logger.info('Sincronizando detalhes dos fornecedores', { stepName });
        
        const detalhesResult = await syncWithPagination(
            `${process.env.SUPABASE_URL}/functions/v1/detalhes_fornecedor`,
            { empresa_id: Number(empresa_id), access_token },
            empresa_id, 
            refresh_token,
            false,
            `${stepName}-detalhes`
        );

        if (metrics) {
            metrics.endStep('completed');
        }

        logOperationEnd(`daily-${stepName}`, true, { 
            empresa_id,
            fornecedores: fornecedoresResult.totalRecordsProcessed,
            detalhes: detalhesResult.totalRecordsProcessed
        });

        logger.info('Sincronização de fornecedores concluída', { 
            stepName,
            fornecedores: fornecedoresResult.totalRecordsProcessed,
            detalhes: detalhesResult.totalRecordsProcessed
        });

        return {
            fornecedores: fornecedoresResult,
            detalhes: detalhesResult,
            totalRecords: fornecedoresResult.totalRecordsProcessed + detalhesResult.totalRecordsProcessed
        };

    } catch (error) {
        if (metrics) {
            metrics.recordError(error, { stepName });
            metrics.endStep('failed');
        }

        logOperationEnd(`daily-${stepName}`, false, {
            empresa_id,
            error: error.message
        });

        logError(error, `daily-${stepName}`, { empresa_id });
        throw error;
    }
}

async function step3_syncVendasAtuais(empresa_id, access_token, refresh_token) {
    const stepName = 'vendas-atuais';
    const logger = createSyncContext(empresa_id, 'daily', stepName);
    const metrics = getSyncMetrics(empresa_id, 'daily');

    logOperationStart(`daily-${stepName}`, { empresa_id });
    
    if (metrics) {
        metrics.startStep(stepName);
    }

    try {
        const today = new Date();
        const yesterday = new Date(today);
        yesterday.setDate(today.getDate() - SYNC.DAILY_PERIOD_DAYS);

        let iterationDate = new Date(today);
        let totalDaysProcessed = 0;

        logger.info('Iniciando sincronização de vendas atuais', {
            stepName,
            periodStart: formatDate(yesterday),
            periodEnd: formatDate(today)
        });

        while (iterationDate >= yesterday) {
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
                    access_token,
                    refresh_token,
                    { context: 'default' }
                );
                
                totalDaysProcessed++;
                
                if (metrics) {
                    const recordCount = result?.recordsProcessed || 0;
                    metrics.recordsProcessed(recordCount);
                }

                logger.info('Dia sincronizado com sucesso', {
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
            
            const delayTime = getDelay('days');
            await delay(delayTime);
        }

        if (metrics) {
            metrics.endStep('completed');
        }

        logOperationEnd(`daily-${stepName}`, true, {
            empresa_id,
            totalDaysProcessed
        });

        logger.info('Sincronização de vendas atuais concluída', {
            stepName,
            totalDaysProcessed
        });

        return {
            totalDaysProcessed
        };

    } catch (error) {
        if (metrics) {
            metrics.recordError(error, { stepName });
            metrics.endStep('failed');
        }

        logOperationEnd(`daily-${stepName}`, false, {
            empresa_id,
            error: error.message
        });

        logError(error, `daily-${stepName}`, { empresa_id });
        throw error;
    }
}

async function step4_syncDetalhesVendas(empresa_id, access_token, refresh_token) {
    const stepName = 'detalhes-vendas';
    const logger = createSyncContext(empresa_id, 'daily', stepName);
    const metrics = getSyncMetrics(empresa_id, 'daily');

    logOperationStart(`daily-${stepName}`, { empresa_id });
    
    if (metrics) {
        metrics.startStep(stepName);
    }

    try {
        const today = new Date();
        const yesterday = new Date(today);
        yesterday.setDate(today.getDate() - SYNC.DAILY_PERIOD_DAYS);

        const data_inicial = yesterday.toISOString().split('T')[0];
        const data_final = today.toISOString().split('T')[0];

        logger.info('Iniciando sincronização de detalhes de vendas', {
            stepName,
            data_inicial,
            data_final
        });
        
        const result = await syncWithPagination(
            `${process.env.SUPABASE_URL}/functions/v1/detalhes_pedido_venda`,
            {
                empresa_id: Number(empresa_id),
                access_token,
                data_inicial,
                data_final
            },
            empresa_id,
            refresh_token,
            false, // Usando 'next_page' para paginação
            stepName
        );

        const miniDelayTime = getDelay('steps', 'mini');
        await delay(miniDelayTime);

        if (metrics) {
            metrics.endStep('completed');
        }

        logOperationEnd(`daily-${stepName}`, true, {
            empresa_id,
            totalRecords: result.totalRecordsProcessed,
            totalPages: result.totalPages
        });

        logger.info('Sincronização de detalhes de vendas concluída', {
            stepName,
            totalRecords: result.totalRecordsProcessed,
            totalPages: result.totalPages
        });

        return result;

    } catch (error) {
        if (metrics) {
            metrics.recordError(error, { stepName });
            metrics.endStep('failed');
        }

        logOperationEnd(`daily-${stepName}`, false, {
            empresa_id,
            error: error.message
        });

        logError(error, `daily-${stepName}`, { empresa_id });
        throw error;
    }
}

async function step5_syncPedidosCompra(empresa_id, access_token, refresh_token) {
    const stepName = 'pedidos-compra';
    const logger = createSyncContext(empresa_id, 'daily', stepName);
    const metrics = getSyncMetrics(empresa_id, 'daily');

    logOperationStart(`daily-${stepName}`, { empresa_id });
    
    if (metrics) {
        metrics.startStep(stepName);
    }

    try {
        // Busca a lista de fornecedores no Supabase
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

        let processedSuppliers = 0;
        let skippedSuppliers = 0;

        // Loop para sincronizar pedidos de compra por fornecedor
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
                    access_token,
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

        logger.info('Loop de fornecedores concluído', {
            stepName,
            processedSuppliers,
            skippedSuppliers,
            totalSuppliers: fornecedoresList.length
        });

        // Sincronização de detalhes dos pedidos de compra
        logger.info('Iniciando sincronização de detalhes de pedidos de compra', { stepName });
        
        const detalhesResult = await syncWithPagination(
            `${process.env.SUPABASE_URL}/functions/v1/detalhes_pedido_compra`,
            { empresa_id: Number(empresa_id), access_token },
            empresa_id, 
            refresh_token,
            false,
            `${stepName}-detalhes`
        );
        
        const miniDelayTime = getDelay('steps', 'mini');
        await delay(miniDelayTime);

        // Sincronização das últimas compras
        logger.info('Iniciando sincronização de últimas compras', { stepName });
        
        const ultimasComprasResult = await syncWithPagination(
            `${process.env.SUPABASE_URL}/functions/v1/sincronizar_ultimas_compras`,
            { empresa_id: Number(empresa_id), access_token },
            empresa_id, 
            refresh_token,
            false,
            `${stepName}-ultimas`
        );
        
        const miniDelayTime2 = getDelay('steps', 'mini');
        await delay(miniDelayTime2);

        if (metrics) {
            metrics.endStep('completed');
        }

        logOperationEnd(`daily-${stepName}`, true, {
            empresa_id,
            processedSuppliers,
            skippedSuppliers,
            detalhes: detalhesResult.totalRecordsProcessed,
            ultimasCompras: ultimasComprasResult.totalRecordsProcessed
        });

        logger.info('Sincronização de pedidos de compra concluída', {
            stepName,
            processedSuppliers,
            skippedSuppliers
        });

        return {
            processedSuppliers,
            skippedSuppliers,
            detalhes: detalhesResult,
            ultimasCompras: ultimasComprasResult,
            totalRecords: detalhesResult.totalRecordsProcessed + ultimasComprasResult.totalRecordsProcessed
        };

    } catch (error) {
        if (metrics) {
            metrics.recordError(error, { stepName });
            metrics.endStep('failed');
        }

        logOperationEnd(`daily-${stepName}`, false, {
            empresa_id,
            error: error.message
        });

        logError(error, `daily-${stepName}`, { empresa_id });
        throw error;
    }
}

async function step6_syncNotasFiscais(empresa_id, access_token, refresh_token) {
    const stepName = 'notas-fiscais';
    const logger = createSyncContext(empresa_id, 'daily', stepName);
    const metrics = getSyncMetrics(empresa_id, 'daily');

    logOperationStart(`daily-${stepName}`, { empresa_id });
    
    if (metrics) {
        metrics.startStep(stepName);
    }

    try {
        const today = new Date();
        const oneMonthAgo = new Date(today);
        oneMonthAgo.setMonth(today.getMonth() - SYNC.NOTES_PERIOD_MONTHS);

        const data_inicial = formatDate(oneMonthAgo);
        const data_final = formatDate(today);

        logger.info('Iniciando sincronização de notas fiscais', {
            stepName,
            data_inicial,
            data_final
        });

        // Sincronizar últimas compras
        await callEdgeFunction(
            `${process.env.SUPABASE_URL}/functions/v1/sincronizar_ultimas_compras`,
            {
                start_date: data_inicial,
                end_date: data_final
            },
            empresa_id,
            access_token,
            refresh_token,
            { context: 'default' }
        );
        
        const delayTime = getDelay('pagination');
        await delay(delayTime);

        // Sincronizar detalhes das notas fiscais (com paginação)
        const detalhesNotasResult = await syncWithPagination(
            `${process.env.SUPABASE_URL}/functions/v1/detalhes_nota_fiscal`,
            { empresa_id: Number(empresa_id), access_token },
            empresa_id, 
            refresh_token,
            false,
            `${stepName}-detalhes`
        );
        
        await delay(delayTime);

        // Buscar chaves de acesso usando `data_emissao`
        logger.info('Buscando chaves de acesso das notas fiscais', {
            stepName,
            data_inicial,
            data_final
        });

        const { data: chavesList, error } = await supabase
            .from("notas_fiscais")
            .select("chave_acesso")
            .eq("empresa_id", Number(empresa_id))
            .not("chave_acesso", "is", null)
            .gte("data_emissao", data_inicial)
            .lte("data_emissao", data_final);

        if (error) throw error;

        logger.info('Chaves de acesso encontradas', {
            stepName,
            totalChaves: chavesList?.length || 0
        });

        let processedNotes = 0;
        let erroredNotes = 0;

        // Loop para sincronizar detalhes das notas fiscais usando as chaves
        for (const [index, nota] of (chavesList || []).entries()) {
            try {
                await callEdgeFunction(
                    `${process.env.SUPABASE_URL}/functions/v1/detalhes_nota_fiscal_chave_acesso`,
                    { chave_acesso: nota.chave_acesso },
                    empresa_id,
                    access_token,
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

        // Chamadas ao serviço de validação EAN
        try {
            logger.info('Iniciando detalhamento de produtos via EAN', { stepName });
            
            await callEdgeFunction(
                `${process.env.VALIDACAO_EAN_URL}/detalhamento_de_produtos/`,
                {
                    webhook_url: process.env.WEBHOOK_URL,
                    data_inicio: data_inicial,
                    data_fim: data_final
                },
                empresa_id,
                access_token,
                refresh_token,
                { 
                    context: 'external',
                    headers: { "Content-Type": "application/json" },
                    maxRetries: 3 
                }
            );
            
        } catch (error) {
            if (metrics) {
                metrics.recordError(error, { stepName, operation: 'detalhamento_produtos' });
            }
            logger.warn('Erro no detalhamento de produtos', {
                stepName,
                error: error.message
            });
        }

        try {
            logger.info('Iniciando vínculo de produtos por fornecedor', { stepName });
            
            await callEdgeFunction(
                `${process.env.VALIDACAO_EAN_URL}/vinculo_produto_por_fornecedor/`,
                { webhook_url: process.env.WEBHOOK_URL_VINCULO },
                empresa_id,
                access_token,
                refresh_token,
                { 
                    context: 'external',
                    headers: { "Content-Type": "application/json" },
                    maxRetries: 3 
                }
            );
            
        } catch (error) {
            if (metrics) {
                metrics.recordError(error, { stepName, operation: 'vinculo_produtos' });
            }
            logger.warn('Erro no vínculo de produtos', {
                stepName,
                error: error.message
            });
        }

        if (metrics) {
            metrics.endStep('completed');
        }

        logOperationEnd(`daily-${stepName}`, true, {
            empresa_id,
            processedNotes,
            erroredNotes,
            totalNotes: chavesList?.length || 0,
            detalhesNotas: detalhesNotasResult.totalRecordsProcessed
        });

        logger.info('Sincronização de notas fiscais concluída', {
            stepName,
            processedNotes,
            erroredNotes,
            totalNotes: chavesList?.length || 0
        });

        return {
            processedNotes,
            erroredNotes,
            totalNotes: chavesList?.length || 0,
            detalhesNotas: detalhesNotasResult,
            totalRecords: processedNotes + detalhesNotasResult.totalRecordsProcessed
        };

    } catch (error) {
        if (metrics) {
            metrics.recordError(error, { stepName });
            metrics.endStep('failed');
        }

        logOperationEnd(`daily-${stepName}`, false, {
            empresa_id,
            error: error.message
        });

        // ✅ CORREÇÃO CRÍTICA: Removido o duplo parênteses logError()()
        logError(error, `daily-${stepName}`, { empresa_id });
        throw error;
    }
}

// =========================
// Fluxo Principal
// =========================

async function executeDailySync(empresa_id, access_token, refresh_token) {
    const logger = createSyncContext(empresa_id, 'daily', 'main-flow');
    const metrics = getSyncMetrics(empresa_id, 'daily');

    logOperationStart('executeDailySync', { empresa_id });

    try {
        // Obtém um token válido
        access_token = await getValidBlingToken(Number(empresa_id), access_token, refresh_token);
        
        logger.info('Token válido obtido para sincronização diária', {
            tokenPreview: `${access_token.substring(0, 8)}***`
        });

        const today = new Date();
        const periodStart = new Date(today);
        periodStart.setDate(today.getDate() - SYNC.DAILY_PERIOD_DAYS);

        const data_inicial = formatDate(periodStart);
        const data_final = formatDate(today);
        
        logger.info('Iniciando sincronização diária', {
            empresa_id,
            periodo: `${data_inicial} até ${data_final}`,
            totalSteps: 6
        });

        // Executa as etapas sequencialmente
        const steps = [
            { name: 'Produtos', fn: () => step1_syncUltimosProdutos(empresa_id, access_token, refresh_token) },
            { name: 'Fornecedores', fn: () => step2_syncFornecedores(empresa_id, access_token, refresh_token) },
            { name: 'Vendas Atuais', fn: () => step3_syncVendasAtuais(empresa_id, access_token, refresh_token) },
            { name: 'Detalhes Vendas', fn: () => step4_syncDetalhesVendas(empresa_id, access_token, refresh_token) },
            { name: 'Pedidos Compra', fn: () => step5_syncPedidosCompra(empresa_id, access_token, refresh_token) },
            { name: 'Notas Fiscais', fn: () => step6_syncNotasFiscais(empresa_id, access_token, refresh_token) }
        ];

        const stepResults = [];
        let totalProcessedRecords = 0;

        for (let i = 0; i < steps.length; i++) {
            const step = steps[i];
            const stepNumber = i + 1;
            
            try {
                logger.info(`Iniciando etapa ${stepNumber}/6: ${step.name}`, {
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

                logger.info(`Etapa ${stepNumber}/6 concluída: ${step.name}`, {
                    stepName: step.name,
                    stepNumber,
                    recordsProcessed: stepResult?.totalRecords || 0
                });

                // Delay entre etapas (exceto na última)
                if (i < steps.length - 1) {
                    const stepDelayTime = getDelay('steps', 'mini');
                    logger.debug('Aplicando delay entre etapas', {
                        currentStep: step.name,
                        nextStep: steps[i + 1].name,
                        delayTime: `${stepDelayTime}ms`
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

                logger.error(`Erro na etapa ${stepNumber}/6: ${step.name}`, {
                    stepName: step.name,
                    stepNumber,
                    error: error.message
                });
                
                // Decide se deve continuar ou parar baseado na criticidade
                if (stepNumber <= 3) { // Etapas críticas (1-3)
                    logger.error('Erro em etapa crítica, interrompendo sincronização', {
                        stepName: step.name,
                        stepNumber
                    });
                    throw error;
                } else { // Etapas não críticas (4-6)
                    logger.warn('Erro em etapa não crítica, continuando sincronização', {
                        stepName: step.name,
                        stepNumber
                    });
                    // Registra erro nas métricas mas continua
                    if (metrics) {
                        metrics.recordError(error, { 
                            stepName: step.name,
                            stepNumber,
                            isCritical: false 
                        });
                    }
                }
            }
        }

        // Calcula estatísticas finais
        const finalStats = {
            success: true,
            message: "Sincronização diária concluída com sucesso",
            empresa_id: Number(empresa_id),
            periodo: `${data_inicial} até ${data_final}`,
            totalSteps: steps.length,
            totalRecordsProcessed: totalProcessedRecords,
            stepResults,
            ...(metrics && {
                metricsRecordsProcessed: metrics.metrics.recordsProcessed.value,
                pagesProcessed: metrics.metrics.pagesProcessed.value,
                errorsCount: metrics.metrics.errorsCount.value,
                retriesCount: metrics.metrics.retriesCount.value
            })
        };

        logOperationEnd('executeDailySync', true, {
            empresa_id,
            ...finalStats
        });

        logger.info('Sincronização diária concluída com sucesso', {
            ...finalStats,
            duration: metrics ? `${Date.now() - metrics.startTime}ms` : 'N/A'
        });

        return finalStats;

    } catch (error) {
        const errorStats = {
            success: false,
            message: "Erro durante a sincronização diária",
            error: error.message || "Erro desconhecido",
            empresa_id: Number(empresa_id),
            ...(metrics && {
                recordsProcessed: metrics.metrics.recordsProcessed.value,
                errorsCount: metrics.metrics.errorsCount.value,
                duration: Date.now() - metrics.startTime
            })
        };

        logOperationEnd('executeDailySync', false, {
            empresa_id,
            error: error.message
        });

        logError(error, 'executeDailySync', {
            empresa_id,
            ...errorStats
        });

        return errorStats;
    }
}

// =========================
// EXPORTAÇÕES
// =========================

module.exports = {
    executeDailySync,
    
    // Funções auxiliares exportadas (para uso em testes ou casos avançados)
    syncWithPagination,
    syncRecentData,
    
    // Funções de step individuais (para uso no syncService)
    step1_syncUltimosProdutos,
    step2_syncFornecedores,
    step3_syncVendasAtuais,
    step4_syncDetalhesVendas,
    step5_syncPedidosCompra,
    step6_syncNotasFiscais
};