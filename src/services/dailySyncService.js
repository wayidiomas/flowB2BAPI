// src/services/dailySyncService.js
require("dotenv").config();
const { formatDate } = require("../utils/dateUtils");
const { delay, callWithNextPage } = require("../utils/pagination");
const { getValidBlingToken } = require("./blingTokenService");
const { executeWithAdvancedRetry } = require("./retryService");
const { callEdgeFunction } = require("./edgeFunctionService");
const supabase = require("./supabaseService");

// =========================
// Funções Auxiliares
// =========================

async function syncWithPagination(url, body, empresa_id, refresh_token, useQuantity = false) {
    let nextPage = 1;
    let quantidade = 100;
    let isPaginationFinished = false; // Flag para encerrar o loop

    while (!isPaginationFinished) {
        try {
            // Prepara o payload com a página atual
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

            // Lógica de paginação dependendo do modo
            if (useQuantity) {
                quantidade = result?.quantidade ?? 0;
                if (quantidade < 100) {
                    console.log(`🏁 [Daily] Paginação finalizada: quantidade (${quantidade}) < 100`);
                    isPaginationFinished = true; // Finaliza quando a quantidade for menor que 100
                } else {
                    nextPage++;
                    console.log(`⏭️ [Daily] Avançando para página: ${nextPage}`);
                }
            } else {
                nextPage = result?.next_page ?? null;
                if (nextPage === null) {
                    console.log(`🏁 [Daily] Paginação finalizada: next_page é null`);
                    isPaginationFinished = true; // Finaliza quando não há mais páginas
                } else {
                    console.log(`⏭️ [Daily] Próxima página: ${nextPage}`);
                }
            }
            
            // Delay entre páginas (só se ainda tiver mais páginas)
            if (!isPaginationFinished) {
                console.log(`⏱️ [Daily] Aguardando 50 segundos antes da próxima página...`);
                await delay(50000);
            }
        } catch (error) {
            console.error(`❌ [Daily] Erro fatal durante paginação:`, error);
            throw error;
        }
    }
}

async function syncRecentData(url, body, limit = 100) {
    let page = 1;
    const allItems = [];

    while (true) {
        try {
            console.log(`🔍 [Daily] Sincronizando dados recentes - Página ${page}`);
            
            // Usa o novo serviço de Edge Function com retry
            const data = await callEdgeFunction(
                url,
                { ...body, page },
                body.empresa_id,
                body.access_token,
                body.refresh_token,
                {
                    maxRetries: 20,
                    initialDelay: 2000,
                    backoffFactor: 1.5
                }
            );
            
            const items = data.data || [];
            console.log(`📦 [Daily] Recebidos ${items.length} registros na página ${page} de ${url}`);
            allItems.push(...items);

            // Encerra o loop se não houver itens na página atual
            if (items.length === 0) {
                console.log("🚫 [Daily] Nenhum item encontrado, encerrando a sincronização.");
                break;
            }

            // Se houver menos itens do que o limite, encerra o loop
            if (items.length < limit) {
                console.log(`🏁 [Daily] Quantidade de itens (${items.length}) menor que o limite (${limit}), encerrando.`);
                break;
            }

            page++;
            console.log(`⏱️ [Daily] Aguardando 50 segundos antes da próxima página...`);
            await delay(50000);
        } catch (error) {
            console.error(`❌ [Daily] Erro durante sincronização de dados recentes - Página ${page}:`, error);
            break; // Encerra o loop em caso de erro
        }
    }

    return allItems;
}

// =========================
// Steps Diários
// =========================

async function step1_syncUltimosProdutos(empresa_id, access_token, refresh_token) {
    console.log("🔄 [Daily] Etapa 1: Sincronizar últimos produtos...");

    try {
        // Define o intervalo de datas (ontem e hoje)
        const today = new Date();
        const yesterday = new Date(today);
        yesterday.setDate(today.getDate() - 1);

        const data_inicial = formatDate(yesterday);
        const data_final = formatDate(today);

        console.log(`📅 [Daily] Intervalo de datas: ${data_inicial} até ${data_final}`);

        const url = `${process.env.SUPABASE_URL}/functions/v1/sincronizar_ultimos_produtos`;
        const body = { 
            empresa_id: Number(empresa_id), 
            access_token, 
            refresh_token,
            data_inicial, 
            data_final 
        };

        await syncRecentData(url, body, 100);
        console.log(`⏱️ [Daily] Aguardando 50 segundos após a última requisição...`);
        await delay(50000);

        console.log("✅ [Daily] Etapa 1: Sincronização de produtos concluída com sucesso.");
    } catch (error) {
        console.error(`❌ [Daily] Erro na Etapa 1 (Produtos):`, error);
        throw error;
    }
}

// ==========================================

async function step2_syncFornecedores(empresa_id, access_token, refresh_token) {
    console.log("🔄 [Daily] Etapa 2: Sincronizar Fornecedores...");

    try {
        // 🔹 Log inicial
        console.log(`🟡 [Daily] Iniciando sincronização de fornecedores para a empresa ID: ${empresa_id}`);

        // 🔹 Sincronizar Fornecedores
        console.log(`📤 [Daily] Sincronizando fornecedores usando endpoint: /sync_fornecedor_by_productID`);
        
        await syncWithPagination(
            `${process.env.SUPABASE_URL}/functions/v1/sync_fornecedor_by_productID`,
            { empresa_id: Number(empresa_id), access_token },
            empresa_id, 
            refresh_token
        );

        console.log(`✅ [Daily] Sincronização de fornecedores concluída.`);

        // 🔹 Sincronizar Detalhes dos Fornecedores
        console.log(`📤 [Daily] Sincronizando detalhes dos fornecedores usando endpoint: /detalhes_fornecedor`);
        
        await syncWithPagination(
            `${process.env.SUPABASE_URL}/functions/v1/detalhes_fornecedor`,
            { empresa_id: Number(empresa_id), access_token },
            empresa_id, 
            refresh_token
        );

        console.log(`✅ [Daily] Sincronização de detalhes dos fornecedores concluída.`);
        console.log("✅ [Daily] Etapa 2: Fornecedores e Detalhes sincronizados com sucesso.");
    } catch (error) {
        console.error("❌ [Daily] Falha na sincronização de fornecedores:", error.message || error);
        throw error;
    }
}

// ==========================================
// STEP 3: Sincronizar Vendas Atuais (Dia Atual)
// ==========================================
async function step3_syncVendasAtuais(empresa_id, access_token, refresh_token) {
    console.log("🔄 [Daily] Etapa 3: Sincronizar vendas atuais...");

    try {
        const today = new Date();
        const yesterday = new Date(today);
        yesterday.setDate(today.getDate() - 1);

        let iterationDate = new Date(today);

        while (iterationDate >= yesterday) {
            const data_dia = iterationDate.toISOString().split('T')[0]; // Formato "YYYY-MM-DD"

            try {
                console.log(`[Step 3] 🗓️ [Daily] Sincronizando pedidos para o dia: ${data_dia}`);
                
                // Usa o novo serviço de Edge Function com retry
                const result = await callEdgeFunction(
                    `${process.env.SUPABASE_URL}/functions/v1/sync_pedido_venda`,
                    {
                        data_dia
                    },
                    empresa_id,
                    access_token,
                    refresh_token
                );
                
                console.log(`[Step 3] ✅ [Daily] Resposta da sincronização para o dia ${data_dia}:`, JSON.stringify(result, null, 2));
            } catch (error) {
                console.error(`[Step 3] ❌ [Daily] Falha ao sincronizar vendas para o dia ${data_dia}:`, error.message);
                // Continua para o próximo dia mesmo em caso de erro
            }

            iterationDate.setDate(iterationDate.getDate() - 1); // Retrocede um dia
            console.log("[Step 3] ⏸️ [Daily] Aguardando 5 segundos antes da próxima iteração...");
            await delay(5000);
        }

        console.log("✅ [Daily] Etapa 3: Vendas atuais sincronizadas com sucesso.");
    } catch (error) {
        console.error(`❌ [Daily] Erro na Etapa 3 (Vendas Atuais):`, error);
        throw error;
    }
}

// ==========================================
// STEP 4: Sincronizar Detalhes das Vendas (Ontem e Hoje) com Paginação
// ==========================================
async function step4_syncDetalhesVendas(empresa_id, access_token, refresh_token) {
    console.log("🔄 [Daily] Etapa 4: Detalhar vendas...");

    try {
        const today = new Date();
        const yesterday = new Date(today);
        yesterday.setDate(today.getDate() - 1);

        const data_inicial = yesterday.toISOString().split('T')[0];
        const data_final = today.toISOString().split('T')[0];

        console.log(`[Step 4] 🗓️ [Daily] Sincronizando detalhes de vendas de ${data_inicial} até ${data_final}`);
        
        await syncWithPagination(
            `${process.env.SUPABASE_URL}/functions/v1/detalhes_pedido_venda`,
            {
                empresa_id: Number(empresa_id),
                access_token,
                data_inicial,
                data_final
            },
            empresa_id,
            refresh_token,
            false // Usando 'next_page' para paginação
        );

        console.log("[Step 4] ✅ [Daily] Sincronização de detalhes de vendas concluída.");
        console.log("[Step 4] ⏸️ [Daily] Aguardando 5 segundos antes da próxima etapa...");
        await delay(5000);

        console.log("✅ [Daily] Etapa 4: Detalhes das vendas sincronizados com sucesso.");
    } catch (error) {
        console.error(`❌ [Daily] Erro na Etapa 4 (Detalhes Vendas):`, error);
        throw error;
    }
}

// ==========================================

async function step5_syncPedidosCompra(empresa_id, access_token, refresh_token) {
    console.log("🔄 [Daily] Etapa 5: Sincronizar pedidos de compra...");

    try {
        // 🔹 Busca a lista de fornecedores no Supabase
        const { data: fornecedoresList, error } = await supabase
            .from("fornecedores")
            .select("id_bling")
            .eq("empresa_id", Number(empresa_id))
            .not("id_bling", "is", null);

        if (error) throw error;

        console.log(`🔎 [Fornecedores] Total de fornecedores encontrados: ${fornecedoresList.length}`);

        // 🔹 Loop para sincronizar pedidos de compra por fornecedor
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
                    {
                        id_bling_fornecedor: forn.id_bling
                    },
                    empresa_id,
                    access_token,
                    refresh_token
                );
                
                console.log(`✅ [Fornecedor ${forn.id_bling}] Sincronização concluída.`);
            } catch (error) {
                console.error(`❌ [Fornecedor ${forn.id_bling}] Erro durante a sincronização:`, error.message);
                // Continua para o próximo fornecedor mesmo em caso de erro
            }

            console.log(`⏸️ Aguardando 5 segundos antes do próximo fornecedor...`);
            await delay(5000);
            
            console.log(`🔁 [Fornecedor ${index + 1}/${fornecedoresList.length}] Finalizado.`);
        }

        console.log("✅ [Fornecedores] Loop de sincronização concluído.");

        // 🔹 Sincronização de detalhes dos pedidos de compra
        console.log("🚀 [detalhes_pedido_compra] Iniciando sincronização...");
        
        await syncWithPagination(
            `${process.env.SUPABASE_URL}/functions/v1/detalhes_pedido_compra`,
            { empresa_id: Number(empresa_id), access_token },
            empresa_id, 
            refresh_token
        );
        
        console.log("✅ [detalhes_pedido_compra] Sincronização concluída.");
        console.log("⏸️ Aguardando 10 segundos antes da próxima etapa...");
        await delay(10000);

        // 🔹 Sincronização das últimas compras
        console.log("🚀 [sincronizar_ultimas_compras] Iniciando sincronização...");
        
        await syncWithPagination(
            `${process.env.SUPABASE_URL}/functions/v1/sincronizar_ultimas_compras`,
            { empresa_id: Number(empresa_id), access_token },
            empresa_id, 
            refresh_token
        );
        
        console.log("✅ [sincronizar_ultimas_compras] Sincronização concluída.");
        console.log("⏸️ Aguardando 5 segundos antes da próxima etapa...");
        await delay(5000);

        console.log("✅ [Daily] Etapa 5: Pedidos de Compra e Detalhes concluídos com sucesso.");
    } catch (error) {
        console.error(`❌ [Daily] Erro na Etapa 5 (Pedidos Compra):`, error);
        throw error;
    }
}

// ==========================================

async function step6_syncNotasFiscais(empresa_id, access_token, refresh_token) {
    console.log("🔄 [Daily] Etapa 6: Sincronizar Notas Fiscais...");

    try {
        const today = new Date();
        const oneMonthAgo = new Date(today);
        oneMonthAgo.setMonth(today.getMonth() - 1);

        const data_inicial = formatDate(oneMonthAgo);
        const data_final = formatDate(today);

        // ✅ Sincronizar últimas compras
        console.log(`🔄 [Daily] Sincronizando últimas compras de ${data_inicial} até ${data_final}...`);
        
        await callEdgeFunction(
            `${process.env.SUPABASE_URL}/functions/v1/sincronizar_ultimas_compras`,
            {
                start_date: data_inicial,
                end_date: data_final
            },
            empresa_id,
            access_token,
            refresh_token
        );
        
        console.log("✅ [sincronizar_ultimas_compras] Concluído.");
        await delay(50000);

        // ✅ Sincronizar detalhes das notas fiscais (com paginação)
        console.log(`🔄 [Daily] Sincronizando detalhes das notas fiscais...`);
        
        await syncWithPagination(
            `${process.env.SUPABASE_URL}/functions/v1/detalhes_nota_fiscal`,
            { empresa_id: Number(empresa_id), access_token },
            empresa_id, 
            refresh_token
        );
        
        console.log("✅ [detalhes_nota_fiscal] Concluído.");
        await delay(50000);

        // ✅ Buscar chaves de acesso usando `data_emissao`
        console.log(`🔎 [Query] Buscando chaves de acesso de ${data_inicial} até ${data_final} usando data_emissao...`);

        const { data: chavesList, error } = await supabase
            .from("notas_fiscais")
            .select("chave_acesso")
            .eq("empresa_id", Number(empresa_id))
            .not("chave_acesso", "is", null)
            .gte("data_emissao", data_inicial)
            .lte("data_emissao", data_final); // Alterado para usar `data_emissao`

        if (error) throw error;

        console.log(`✅ [Query] Total de chaves encontradas: ${chavesList?.length || 0}`);

        // ✅ Loop para sincronizar detalhes das notas fiscais usando as chaves
        for (const [index, nota] of (chavesList || []).entries()) {
            try {
                console.log(`🔄 [Daily] Sincronizando nota ${index + 1}/${chavesList.length} - Chave: ${nota.chave_acesso.substring(0, 10)}...`);
                
                await callEdgeFunction(
                    `${process.env.SUPABASE_URL}/functions/v1/detalhes_nota_fiscal_chave_acesso`,
                    {
                        chave_acesso: nota.chave_acesso
                    },
                    empresa_id,
                    access_token,
                    refresh_token,
                    { maxRetries: 5 } // Menos tentativas para não travar muito tempo
                );
                
                console.log(`✅ [Nota] Chave ${nota.chave_acesso.substring(0, 10)}... sincronizada.`);
            } catch (error) {
                console.error(`❌ [Nota] Erro ao sincronizar chave ${nota.chave_acesso.substring(0, 10)}...:`, error.message);
                // Continua para a próxima nota mesmo em caso de erro
            }
            
            await delay(5000);
            
            // Pausa extra a cada 10 notas
            if (index % 10 === 9) {
                console.log(`⏸️ Pausa extra após 10 notas. Aguardando 15 segundos...`);
                await delay(15000);
            }
        }

        // ✅ Chamadas ao VALIDACAO_EAN_URL (sem delay)
        console.log(`🔄 [Daily] Iniciando detalhamento de produtos...`);
        
        try {
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
                    headers: { "Content-Type": "application/json" },
                    maxRetries: 3 
                }
            );
            
            console.log("✅ [detalhamento_de_produtos] Concluído.");
        } catch (error) {
            console.error(`❌ [detalhamento_de_produtos] Erro:`, error.message);
        }

        console.log(`🔄 [Daily] Iniciando vínculo de produtos por fornecedor...`);
        
        try {
            await callEdgeFunction(
                `${process.env.VALIDACAO_EAN_URL}/vinculo_produto_por_fornecedor/`,
                {
                    webhook_url: process.env.WEBHOOK_URL_VINCULO
                },
                empresa_id,
                access_token,
                refresh_token,
                { 
                    headers: { "Content-Type": "application/json" },
                    maxRetries: 3 
                }
            );
            
            console.log("✅ [vinculo_produto_por_fornecedor] Concluído.");
        } catch (error) {
            console.error(`❌ [vinculo_produto_por_fornecedor] Erro:`, error.message);
        }

        console.log("✅ [Daily] Etapa 6: Notas fiscais e vinculações concluídas com sucesso.");
    } catch (error) {
        console.error(`❌ [Daily] Erro na Etapa 6 (Notas Fiscais):`, error);
        throw error;
    }
}

// =========================
// Fluxo Principal
// =========================

async function executeDailySync(empresa_id, access_token, refresh_token) {
    console.log(`\n🚀 [Daily] Iniciando sincronização para empresa ${empresa_id}`);

    try {
        // Obtém um token válido
        access_token = await getValidBlingToken(Number(empresa_id), access_token, refresh_token);
        console.log(`🔑 [Daily] Token válido obtido: ${access_token.substring(0, 10)}...`);

        const today = new Date();
        const oneDayAgo = new Date(today);
        oneDayAgo.setDate(today.getDate() - 1);

        const data_inicial = formatDate(oneDayAgo);
        const data_final = formatDate(today);
        console.log(`📅 [Daily] Período de sincronização: ${data_inicial} até ${data_final}`);

        // Executa as etapas sequencialmente
        await step1_syncUltimosProdutos(empresa_id, access_token, refresh_token, data_inicial, data_final);
        await step2_syncFornecedores(empresa_id, access_token, refresh_token);
        await step3_syncVendasAtuais(empresa_id, access_token, refresh_token);
        await step4_syncDetalhesVendas(empresa_id, access_token, refresh_token);
        await step5_syncPedidosCompra(empresa_id, access_token, refresh_token);
        await step6_syncNotasFiscais(empresa_id, access_token, refresh_token);

        console.log("✅ [Daily] Todas as etapas de sincronização diária foram concluídas com sucesso!");
        return { success: true, message: "Daily sync completed" };
    } catch (error) {
        console.error(`❌ [Daily] Erro durante a sincronização:`, error);
        return { 
            success: false, 
            message: "Erro durante a sincronização diária", 
            error: error.message || "Erro desconhecido" 
        };
    }
}

module.exports = {
    executeDailySync,
};