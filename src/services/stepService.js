// src/services/stepService.js

const supabase = require("./supabaseService");
const dateUtils = require('../utils/dateUtils');
const { callWithNextPage, delay } = require("../utils/pagination");
const { getValidBlingToken } = require("./blingTokenService");
const { executeWithAdvancedRetry } = require("./retryService");
const { callEdgeFunction } = require("./edgeFunctionService");

const TIME_80s = 80_000;

// =========================
// Funções Auxiliares de Paginação
// =========================

async function syncWithPagination(url, body, empresa_id, refresh_token, useQuantity = false) {
    let nextPage = 1;
    let quantidade = 100;
    let isPaginationFinished = false; // Flag para encerrar o loop

    while (!isPaginationFinished) {
        try {
            // Atualiza a página no payload
            const payload = { ...body, page: nextPage };
            
            // Usa o novo serviço de Edge Function com retry
            const result = await callEdgeFunction(
                url,
                payload,
                empresa_id,
                body.access_token,
                refresh_token,
                {
                    maxRetries: 20,
                    initialDelay: 2000,
                    backoffFactor: 1.5
                }
            );
            
            // Determina se a paginação deve continuar com base no modo de paginação
            if (useQuantity) {
                quantidade = result?.quantidade ?? 0;
                if (quantidade < 100) {
                    isPaginationFinished = true; // Finaliza quando a quantidade for menor que 100
                    console.log(`🏁 Paginação concluída: quantidade (${quantidade}) < 100`);
                } else {
                    nextPage++;
                    console.log(`⏭️ Próxima página: ${nextPage}`);
                }
            } else {
                nextPage = result?.next_page ?? null;
                if (nextPage === null) {
                    isPaginationFinished = true; // Finaliza quando não há mais páginas
                    console.log(`🏁 Paginação concluída: next_page é null`);
                } else {
                    console.log(`⏭️ Próxima página: ${nextPage}`);
                }
            }
            
            // Delay entre requisições
            if (!isPaginationFinished) {
                console.log(`⏱️ Aguardando 50 segundos antes da próxima página...`);
                await delay(50000);
            }
        } catch (error) {
            console.error(`❌ Erro fatal durante a paginação:`, error);
            throw error; // Propaga o erro após todas as tentativas de retry falharem
        }
    }
}

async function etapaProdutos(empresa_id, accessToken, refresh_token, paginaAtual = 1) {
    console.log("🚀 [Etapa 1] Iniciando sincronização de Produtos e Detalhes");

    try {
        // Step 1: Sincronizar produtos usando quantidade (< 100 para encerrar)
        console.log("🔍 [Etapa 1.1] Sincronizando produtos...");
        await syncWithPagination(
            `${process.env.SUPABASE_URL}/functions/v1/sync_prod_2`,
            { empresa_id, access_token: accessToken, page: paginaAtual },
            empresa_id, 
            refresh_token, 
            true // ✅ Controla paginação usando 'quantidade'
        );

        // Step 2: Sincronizar detalhes do produto usando next_page
        console.log("🔍 [Etapa 1.2] Sincronizando detalhes dos produtos...");
        await syncWithPagination(
            `${process.env.SUPABASE_URL}/functions/v1/sync_detalhes_prod`,
            { empresa_id, access_token: accessToken },
            empresa_id, 
            refresh_token, 
            false // ✅ Controla paginação usando 'next_page'
        );

        console.log("✅ [Etapa 1] Produtos e Detalhes concluídos com sucesso.");
    } catch (error) {
        console.error("❌ [Etapa 1] Erro na sincronização de produtos:", error);
        throw error;
    }
}

// =========================
// Etapa 2: Fornecedores e Detalhes
// =========================

async function etapaFornecedores(empresa_id, accessToken, refresh_token) {
    console.log("🚀 [Etapa 2] Iniciando sincronização de Fornecedores e Detalhes");
    
    try {
        // Sincroniza fornecedores por produto
        console.log("🔍 [Etapa 2.1] Sincronizando fornecedores por produto...");
        await syncWithPagination(
            `${process.env.SUPABASE_URL}/functions/v1/sync_fornecedor_by_productID`,
            { empresa_id, access_token: accessToken },
            empresa_id, 
            refresh_token
        );
        
        // Sincroniza detalhes dos fornecedores
        console.log("🔍 [Etapa 2.2] Sincronizando detalhes dos fornecedores...");
        await syncWithPagination(
            `${process.env.SUPABASE_URL}/functions/v1/detalhes_fornecedor`,
            { empresa_id, access_token: accessToken },
            empresa_id, 
            refresh_token
        );

        console.log("✅ [Etapa 2] Fornecedores e Detalhes concluídos com sucesso.");
    } catch (error) {
        console.error("❌ [Etapa 2] Erro na sincronização de fornecedores:", error);
        throw error;
    }
}

// =========================
// Etapa 3: Pedidos de Venda e Detalhes
// =========================

async function etapaPedidosVenda(empresa_id, accessToken, refresh_token) {
    console.log("🚀 [Etapa 3] Iniciando sincronização de Pedidos de Venda e Detalhes");

    try {
        const currentDate = new Date();
        const oneYearAgo = new Date(currentDate);
        oneYearAgo.setFullYear(currentDate.getFullYear() - 1);

        let iterationDate = new Date(currentDate);

        // 🔹 Loop de sincronização diaria de pedidos de venda
        console.log("🔍 [Etapa 3.1] Sincronizando pedidos de venda por dia...");
        
        while (iterationDate >= oneYearAgo) {
            const data_dia = iterationDate.toISOString().split('T')[0]; // Formata a data como "YYYY-MM-DD"
            
            console.log(`[Loop Pedido Venda] 🗓️ Sincronizando pedidos para o dia: ${data_dia}`);
            
            try {
                // Usa o novo serviço de Edge Function com retry
                const result = await callEdgeFunction(
                    `${process.env.SUPABASE_URL}/functions/v1/sync_pedido_venda`,
                    { data_dia },
                    empresa_id,
                    accessToken,
                    refresh_token
                );
                
                console.log(`[Loop Pedido Venda] ✅ Resposta da sincronização para o dia ${data_dia}:`, result);
            } catch (error) {
                // Registra o erro mas continua para o próximo dia
                console.error(`❌ [Loop Pedido Venda] Erro ao sincronizar o dia ${data_dia}:`, error.message);
            }
            
            iterationDate.setDate(iterationDate.getDate() - 1); // Retrocede um dia
            console.log(`[Loop Pedido Venda] ⏸️ Aguardando 5 segundos antes da próxima iteração...`);
            await delay(5000); // ✅ Delay de 5 segundos após cada requisição
        }
        
        // 🔹 Loop de sincronização semanal de detalhes dos pedidos de venda
        console.log("🔍 [Etapa 3.2] Sincronizando detalhes dos pedidos de venda...");
        
        await syncWithPagination(
            `${process.env.SUPABASE_URL}/functions/v1/detalhes_pedido_venda`,
            { empresa_id, access_token: accessToken },
            empresa_id, 
            refresh_token
        );
        
        console.log(`[Loop Detalhe Pedido Venda] ⏸️ Aguardando 5 segundos antes da próxima etapa...`);
        await delay(5000);
        
        console.log("✅ [Etapa 3] Pedidos de Venda e Detalhes concluídos com sucesso.");
    } catch (error) {
        console.error("❌ [Etapa 3] Erro na sincronização de pedidos de venda:", error);
        throw error;
    }
}

// =========================
// Etapa 4: Pedidos de Compra e Detalhes
// =========================

async function etapaPedidosCompra(empresa_id, accessToken, refresh_token) {
    console.log("🚀 [Etapa 4] Iniciando sincronização de Pedidos de Compra e Detalhes");

    try {
        const { data: fornecedoresList, error } = await supabase
            .from("fornecedores")
            .select("id_bling")
            .eq("empresa_id", Number(empresa_id))
            .not("id_bling", "is", null);

        if (error) throw error;

        console.log(`🔎 [Fornecedores] Total de fornecedores encontrados: ${fornecedoresList.length}`);

        // 🔹 Loop para sincronizar pedidos de compra por fornecedor
        console.log("🔍 [Etapa 4.1] Sincronizando pedidos de compra por fornecedor...");
        
        for (const [index, forn] of fornecedoresList.entries()) {
            if (forn.id_bling === 0) {
                console.warn(`⚠️ [Fornecedor ${index + 1}/${fornecedoresList.length}] Ignorado - ID inválido: ${forn.id_bling}`);
                continue; // Pule este fornecedor
            }

            console.log(`🔁 [Fornecedor ${index + 1}/${fornecedoresList.length}] Iniciando sincronização - ID: ${forn.id_bling}`);

            try {
                // Usa o novo serviço de Edge Function com retry
                await callEdgeFunction(
                    `${process.env.SUPABASE_URL}/functions/v1/sync_pedido_compra`,
                    { id_bling_fornecedor: forn.id_bling },
                    empresa_id,
                    accessToken,
                    refresh_token
                );
                
                console.log(`✅ [Fornecedor ${forn.id_bling}] Sincronização concluída.`);
            } catch (error) {
                // Registra o erro mas continua para o próximo fornecedor
                console.error(`❌ [Fornecedor ${forn.id_bling}] Erro durante a sincronização:`, error.message);
            }

            console.log(`⏸️ Aguardando 5 segundos antes do próximo fornecedor...`);
            await delay(5000);
            
            console.log(`🔁 [Fornecedor ${index + 1}/${fornecedoresList.length}] Finalizado.`);
        }

        console.log("✅ [Fornecedores] Loop de sincronização concluído.");

        // 🔹 Sincronização de detalhes dos pedidos de compra
        console.log("🔍 [Etapa 4.2] Sincronizando detalhes de pedidos de compra...");
        
        await syncWithPagination(
            `${process.env.SUPABASE_URL}/functions/v1/detalhes_pedido_compra`,
            { empresa_id, access_token: accessToken },
            empresa_id, 
            refresh_token
        );
        
        console.log("✅ [detalhes_pedido_compra] Sincronização concluída.");
        console.log("⏸️ Aguardando 10 segundos antes da próxima etapa...");
        await delay(10000);

        // 🔹 Sincronização das últimas compras
        console.log("🔍 [Etapa 4.3] Sincronizando últimas compras...");
        
        await syncWithPagination(
            `${process.env.SUPABASE_URL}/functions/v1/sincronizar_ultimas_compras`,
            { empresa_id, access_token: accessToken },
            empresa_id, 
            refresh_token
        );
        
        console.log("✅ [sincronizar_ultimas_compras] Sincronização concluída.");
        console.log("⏸️ Aguardando 5 segundos antes da próxima etapa...");
        await delay(5000);

        console.log("✅ [Etapa 4] Pedidos de Compra e Detalhes concluídos com sucesso.");
    } catch (error) {
        console.error("❌ [Etapa 4] Erro na sincronização de pedidos de compra:", error);
        throw error;
    }
}

// =========================
// Etapa 5: Fluxo de Notas Fiscais
// =========================

async function etapaNotasFiscais(empresa_id, accessToken, refresh_token) {
    console.log("🚀 [Etapa 5] Iniciando sincronização do Fluxo de Notas Fiscais");

    try {
        const currentDate = new Date();
        const oneYearAgo = new Date(currentDate);
        oneYearAgo.setFullYear(currentDate.getFullYear() - 1);

        let iterationDate = new Date(currentDate);

        // 🔹 Loop de sincronização mensal de últimas compras
        console.log("🔍 [Etapa 5.1] Sincronizando últimas compras por mês...");
        
        while (iterationDate >= oneYearAgo) {
            const startDate = new Date(iterationDate);
            startDate.setDate(1); // Início do mês
            const endDate = new Date(iterationDate);
            endDate.setDate(new Date(endDate.getFullYear(), endDate.getMonth() + 1, 0).getDate()); // Fim do mês

            try {
                // Usa o novo serviço de Edge Function com retry
                await callEdgeFunction(
                    `${process.env.SUPABASE_URL}/functions/v1/sincronizar_ultimas_compras`,
                    {
                        start_date: dateUtils.formatDate(startDate),
                        end_date: dateUtils.formatDate(endDate)
                    },
                    empresa_id,
                    accessToken,
                    refresh_token
                );
                
                console.log(`✅ [Últimas Compras] Mês ${dateUtils.formatDate(startDate)} sincronizado.`);
            } catch (error) {
                // Registra o erro mas continua para o próximo mês
                console.error(`❌ [Últimas Compras] Erro ao sincronizar mês ${dateUtils.formatDate(startDate)}:`, error.message);
            }

            await delay(20000); // Delay de 20 segundos após cada requisição
            iterationDate.setMonth(iterationDate.getMonth() - 1); // Retrocede um mês
        }

        console.log("✅ [Loop Mensal Concluído] Sincronização de últimas compras finalizada.");

        // 🔹 Sincronização de detalhes das notas fiscais
        console.log("🔍 [Etapa 5.2] Sincronizando detalhes das notas fiscais...");
        
        await syncWithPagination(
            `${process.env.SUPABASE_URL}/functions/v1/detalhes_nota_fiscal`,
            { empresa_id, access_token: accessToken },
            empresa_id, 
            refresh_token
        );
        
        console.log(`✅ [Sucesso] Detalhes das notas fiscais sincronizados.`);
        await delay(50000);

        // 🔹 Loop de sincronização de notas fiscais por chave de acesso
        console.log("🔍 [Etapa 5.3] Sincronizando notas fiscais por chave de acesso...");
        
        const { data: chavesList, error } = await supabase
            .from("notas_fiscais")
            .select("chave_acesso")
            .eq("empresa_id", Number(empresa_id))
            .not("chave_acesso", "is", null);

        if (error) throw error;

        console.log(`📦 [Notas Fiscais] Total de chaves encontradas: ${chavesList.length}`);

        for (const [index, nota] of chavesList.entries()) {
            try {
                // Usa o novo serviço de Edge Function com retry
                await callEdgeFunction(
                    `${process.env.SUPABASE_URL}/functions/v1/detalhes_nota_fiscal_chave_acesso`,
                    {
                        chave_acesso: nota.chave_acesso
                    },
                    empresa_id,
                    accessToken,
                    refresh_token,
                    { maxRetries: 5 } // Menos tentativas para não travar muito tempo
                );
                
                console.log(`✅ [Nota ${index + 1}/${chavesList.length}] Chave ${nota.chave_acesso} sincronizada.`);
            } catch (error) {
                // Registra o erro mas continua para a próxima nota
                console.error(`❌ [Nota ${index + 1}/${chavesList.length}] Erro ao sincronizar chave ${nota.chave_acesso}:`, error.message);
            }

            if (index % 10 === 0 && index > 0) {
                console.log(`⏸️ Pausa extra a cada 10 notas. Aguardando 5 segundos...`);
                await delay(5000);
            } else {
                await delay(500);
            }
        }

        // 🔹 Detalhamento de Produtos
        console.log("🔍 [Etapa 5.4] Detalhamento de produtos...");
        
        try {
            // Usa o novo serviço de Edge Function com retry para outro endpoint
            await callEdgeFunction(
                `${process.env.VALIDACAO_EAN_URL}/detalhamento_de_produtos/`,
                {
                    webhook_url: process.env.WEBHOOK_URL,
                    data_inicio: dateUtils.formatDate(oneYearAgo),
                    data_fim: dateUtils.formatDate(currentDate)
                },
                empresa_id,
                accessToken,
                refresh_token,
                { 
                    headers: { "Content-Type": "application/json" },
                    maxRetries: 3 
                }
            );
            
            console.log(`✅ [Sucesso] Detalhamento de produtos sincronizado.`);
        } catch (error) {
            console.error(`❌ [Erro] Falha no detalhamento de produtos:`, error.message);
        }

        // 🔹 Vínculo de Produtos por Fornecedor
        console.log("🔍 [Etapa 5.5] Vínculo de produtos por fornecedor...");
        
        try {
            // Usa o novo serviço de Edge Function com retry para outro endpoint
            await callEdgeFunction(
                `${process.env.VALIDACAO_EAN_URL}/vinculo_produto_por_fornecedor/`,
                {
                    webhook_url: process.env.WEBHOOK_URL_VINCULO
                },
                empresa_id,
                accessToken,
                refresh_token,
                { 
                    headers: { "Content-Type": "application/json" },
                    maxRetries: 3 
                }
            );
            
            console.log(`✅ [Sucesso] Vínculo de produtos sincronizado.`);
        } catch (error) {
            console.error(`❌ [Erro] Falha no vínculo de produtos:`, error.message);
        }

        // 🔹 Sincronização de estoque
        console.log("🔍 [Etapa 5.6] Sincronizando estoque...");
        
        await syncWithPagination(
            `${process.env.SUPABASE_URL}/functions/v1/sync_estoque`,
            { empresa_id, access_token: accessToken },
            empresa_id, 
            refresh_token
        );
        
        console.log(`✅ [Sucesso] Sincronização de estoque concluída.`);
        await delay(5000);

        // 🔹 Sincronização de formas de pagamento dos pedidos de compra
        console.log("🔍 [Etapa 5.7] Sincronizando formas de pagamento...");
        
        await syncWithPagination(
            `${process.env.SUPABASE_URL}/functions/v1/sync_formas_de_pagamento_pedidos_de_compra`,
            { empresa_id, access_token: accessToken },
            empresa_id, 
            refresh_token
        );
        
        console.log(`✅ [Sucesso] Sincronização de formas de pagamento concluída.`);
        await delay(5000);

        console.log("✅ [Etapa 5] Fluxo de Notas Fiscais concluído com sucesso.");
    } catch (error) {
        console.error("❌ [Etapa 5] Erro na sincronização de notas fiscais:", error);
        throw error;
    }
}

// =========================
// Função Principal
// =========================

async function executeSteps(empresa_id, accessToken, refresh_token, paginaAtual = 1) {
    try {
        console.log(`🚀 Iniciando sincronização em etapas para empresa ${empresa_id}, página inicial: ${paginaAtual}`);
        
        // Obtém um token válido
        const token = await getValidBlingToken(Number(empresa_id), accessToken, refresh_token);
        console.log(`🔑 Token válido obtido: ${token.substring(0, 10)}...`);
        
        // Executa as etapas sequencialmente
        await etapaProdutos(empresa_id, token, refresh_token, paginaAtual);
        console.log(`⏸️ Aguardando ${TIME_80s/1000} segundos antes da próxima etapa...`);
        await delay(TIME_80s);
        
        await etapaFornecedores(empresa_id, token, refresh_token);
        console.log(`⏸️ Aguardando ${TIME_80s/1000} segundos antes da próxima etapa...`);
        await delay(TIME_80s);
        
        await etapaPedidosVenda(empresa_id, token, refresh_token);
        console.log(`⏸️ Aguardando ${TIME_80s/1000} segundos antes da próxima etapa...`);
        await delay(TIME_80s);
        
        await etapaPedidosCompra(empresa_id, token, refresh_token);
        console.log(`⏸️ Aguardando ${TIME_80s/1000} segundos antes da próxima etapa...`);
        await delay(TIME_80s);
        
        await etapaNotasFiscais(empresa_id, token, refresh_token);

        console.log("✅ Sincronização concluída com sucesso!");
        return { success: true, message: "Sincronização completa concluída com sucesso" };
    } catch (error) {
        console.error("❌ Erro durante a sincronização:", error);
        return { 
            success: false, 
            message: "Erro durante a sincronização", 
            error: error.message || "Erro desconhecido" 
        };
    }
}

module.exports = {
    executeSteps,
};