require("dotenv").config();
const { formatDate } = require("../utils/dateUtils");
const { delay, callWithNextPage } = require("../utils/pagination");
const { getValidBlingToken } = require("./blingTokenService");
const { executeWithRetry } = require("./retryService"); // ✅ Importação adicionada
const supabase = require("./supabaseService");


// =========================
// Funções Auxiliares
// =========================

async function syncWithPagination(url, body, empresa_id, refresh_token, useQuantity = false) {
    let nextPage = 1;
    let quantidade = 100;
    let isPaginationFinished = false; // Flag para encerrar o loop

    while (!isPaginationFinished) {
        body.page = nextPage;

        await executeWithRetry(async (token) => {
            body.access_token = token; // Atualiza o token antes da chamada
            const result = await callWithNextPage(url, body, {}, 50000, useQuantity); // ✅ Delay de 50s diretamente no callWithNextPage

            if (useQuantity) {
                quantidade = result?.quantidade ?? 0;
                if (quantidade < 100) isPaginationFinished = true; // Finaliza quando a quantidade for menor que 100
                else nextPage++;
            } else {
                nextPage = result?.next_page ?? null;
                if (nextPage === null) isPaginationFinished = true; // Finaliza quando não há mais páginas
            }
        }, empresa_id, body.access_token, refresh_token);
    }
}
async function syncRecentData(url, body, limit = 100) {
    let page = 1;
    const allItems = [];

    while (true) {
        body.page = page;

        await executeWithRetry(async (token) => {
            body.access_token = token;
            const response = await global.fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Erro HTTP em ${url} - Página ${page}: ${response.status} - ${errorText}`);
            }

            const data = await response.json();
            const items = data.data || [];
            console.log(`Recebidos ${items.length} registros na página ${page} de ${url}`);
            allItems.push(...items);

            // ✅ Encerra o loop se não houver itens na página atual
            if (items.length === 0) {
                console.log("🚫 Nenhum item encontrado, encerrando a sincronização.");
                return; // Interrompe o executeWithRetry
            }

            // ✅ Se houver menos itens do que o limite, encerra o loop
            if (items.length < limit) return;

            page++;
            await delay(50000); // ✅ Delay de 50 segundos após cada requisição
        }, body.access_token);

        // ✅ Se não houver mais páginas, encerra o loop
        if (allItems.length === 0 || page === null) break;
    }

    return allItems;
}

async function syncFornecedoresWithPagination(empresa_id, access_token, refresh_token) {
    console.log("🔄 [Daily] Sincronizando fornecedores...");

    let nextPage = 1;

    while (nextPage !== null) {
        await executeWithRetry(async (token) => {
            const response = await global.fetch(`${process.env.SUPABASE_URL}/functions/v1/sync_fornecedor_by_productID`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    access_token: token,
                    empresa_id,
                    page: nextPage,
                }),
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Erro ao sincronizar fornecedores - Página ${nextPage}: ${response.status} - ${errorText}`);
            }

            const data = await response.json();
            console.log(`Fornecedores - Página ${nextPage} sincronizada.`);

            nextPage = data.next_page ?? null;
            await delay(50000); // ✅ Delay de 50 segundos após cada requisição
        }, access_token, refresh_token);
    }

    console.log("✅ [Daily] Sincronização de fornecedores concluída.");
}


async function syncPedidosCompraWithPagination(empresa_id, access_token, refresh_token) {
    console.log("🔄 [Daily] Sincronizando pedidos de compra...");

    let nextPage = 1;

    while (nextPage !== null) {
        await executeWithRetry(async (token) => {
            const response = await global.fetch(`${process.env.SUPABASE_URL}/functions/v1/sync_pedido_compra`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    access_token: token,
                    empresa_id,
                    page: nextPage,
                }),
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Erro ao sincronizar pedidos de compra - Página ${nextPage}: ${response.status} - ${errorText}`);
            }

            const data = await response.json();
            console.log(`Pedidos de compra - Página ${nextPage} sincronizada.`);

            nextPage = data.next_page ?? null;
            await delay(50000); // ✅ Delay de 50 segundos após cada requisição
        }, access_token, refresh_token);
    }

    console.log("✅ [Daily] Sincronização de pedidos de compra concluída.");
}


// =========================
// Steps Diários
// =========================

async function step1_syncUltimosProdutos(empresa_id, access_token, refresh_token) {
    console.log("🔄 [Daily] Etapa 1: Sincronizar últimos produtos...");

    // Define o intervalo de datas (ontem e hoje)
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);

    const data_inicial = formatDate(yesterday);
    const data_final = formatDate(today);

    const url = `${process.env.SUPABASE_URL}/functions/v1/sincronizar_ultimos_produtos`;
    const body = { empresa_id, access_token, data_inicial, data_final };

    await syncRecentData(url, body, 100);
    await delay(50000); // ✅ Delay de 50 segundos após a última requisição

    console.log("✅ [Daily] Etapa 1: Sincronização de produtos concluída.");
}

// ==========================================

async function step2_syncFornecedores(empresa_id, access_token, refresh_token) {
    console.log("🔄 [Daily] Etapa 2: Sincronizar Fornecedores...");

    try {
        // 🔹 Log inicial
        console.log(`🟡 Iniciando sincronização de fornecedores para a empresa ID: ${empresa_id}`);

        // 🔹 Sincronizar Fornecedores
        console.log(`📤 [Request] Sincronizando fornecedores usando endpoint: /sync_fornecedor_by_productID`);
        await executeWithRetry(async (token) => {
            console.log(`🔑 [Access Token] Token utilizado: ${token}`);
            console.log(`📦 [Payload] Enviando: { empresa_id: ${empresa_id}, access_token: ${token} }`);

            await syncWithPagination(
                `${process.env.SUPABASE_URL}/functions/v1/sync_fornecedor_by_productID`,
                { empresa_id: Number(empresa_id), access_token: token },
                empresa_id, refresh_token
            );

            console.log(`✅ [Success] Sincronização de fornecedores concluída.`);
        }, empresa_id, access_token, refresh_token);

        // 🔹 Sincronizar Detalhes dos Fornecedores
        console.log(`📤 [Request] Sincronizando detalhes dos fornecedores usando endpoint: /detalhes_fornecedor`);
        await executeWithRetry(async (token) => {
            console.log(`🔑 [Access Token] Token utilizado: ${token}`);
            console.log(`📦 [Payload] Enviando: { empresa_id: ${empresa_id}, access_token: ${token} }`);

            await syncWithPagination(
                `${process.env.SUPABASE_URL}/functions/v1/detalhes_fornecedor`,
                { empresa_id: Number(empresa_id), access_token: token },
                empresa_id, refresh_token
            );

            console.log(`✅ [Success] Sincronização de detalhes dos fornecedores concluída.`);
        }, empresa_id, access_token, refresh_token);

        console.log("✅ [Daily] Etapa 2: Fornecedores e Detalhes sincronizados com sucesso.");
    } catch (error) {
        console.error("❌ [Erro] Falha na sincronização de fornecedores:", error.message || error);
        throw error; // Lança o erro para ser capturado no fluxo principal
    }
}


// ==========================================
// STEP 3: Sincronizar Vendas Atuais (Dia Atual)
// ==========================================
async function step3_syncVendasAtuais(empresa_id, access_token, refresh_token) {
    console.log("🔄 [Daily] Etapa 3: Sincronizar vendas atuais...");

    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);

    let iterationDate = new Date(today);

    await executeWithRetry(async (token) => {
        while (iterationDate >= yesterday) {
            const data_dia = iterationDate.toISOString().split('T')[0]; // Formato "YYYY-MM-DD"

            try {
                console.log(`[Step 3] 🗓️ Sincronizando pedidos para o dia: ${data_dia}`);
                console.log(`[Step 3] 📨 Enviando payload:`, {
                    empresa_id: Number(empresa_id),
                    access_token: token,
                    data_dia
                });

                const url = `${process.env.SUPABASE_URL}/functions/v1/sync_pedido_venda`;
                console.log(`[Step 3] 🌐 [Request] URL: ${url}`);

                const response = await global.fetch(url, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        empresa_id: Number(empresa_id),
                        access_token: token,
                        data_dia
                    }),
                });

                console.log(`[Step 3] 📥 [Response] Status: ${response.status}`);

                if (!response.ok) {
                    const errorText = await response.text();
                    console.error(`[Step 3] ❌ Erro na resposta da API: ${response.status} - ${errorText}`);
                    throw new Error(`Erro ao sincronizar vendas atuais: ${response.status} - ${errorText}`);
                }

                const result = await response.json();
                console.log(`[Step 3] ✅ [Success] Resposta da sincronização para o dia ${data_dia}:`, JSON.stringify(result, null, 2));

                iterationDate.setDate(iterationDate.getDate() - 1); // Retrocede um dia

                console.log("[Step 3] ⏸️ Aguardando 5 segundos antes da próxima iteração...");
                await delay(5000); // ✅ Delay de 5 segundos após cada requisição
            } catch (error) {
                console.error(`[Step 3] ❌ [Erro] Falha ao sincronizar vendas atuais:`, error.message || error);
                throw error; // Relança o erro para ser capturado pelo retry
            }
        }
    }, empresa_id, access_token, refresh_token);

    console.log("✅ [Daily] Etapa 3: Vendas atuais sincronizadas com sucesso.");
}


// ==========================================

// ==========================================
// STEP 4: Sincronizar Detalhes das Vendas (Ontem e Hoje) com Paginação
// ==========================================
async function step4_syncDetalhesVendas(empresa_id, access_token, refresh_token) {
    console.log("🔄 [Daily] Etapa 4: Detalhar vendas...");

    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);

    const data_inicial = yesterday.toISOString().split('T')[0];
    const data_final = today.toISOString().split('T')[0];

    await executeWithRetry(async (token) => {
        try {
            console.log(`[Step 4] 🗓️ Sincronizando detalhes de vendas de ${data_inicial} até ${data_final}`);
            console.log(`[Step 4] 📨 Payload inicial:`, {
                empresa_id: Number(empresa_id),
                access_token: token,
                data_inicial,
                data_final
            });

            const url = `${process.env.SUPABASE_URL}/functions/v1/detalhes_pedido_venda`;
            console.log(`[Step 4] 🌐 [Request] URL: ${url}`);

            await syncWithPagination(
                url,
                {
                    empresa_id: Number(empresa_id),
                    access_token: token,
                    data_inicial,
                    data_final
                },
                empresa_id,
                refresh_token,
                false // ✅ Usando 'next_page' para paginação
            );

            console.log("[Step 4] ✅ [Success] Sincronização de detalhes de vendas concluída.");
            console.log("[Step 4] ⏸️ Delay de 5 segundos antes da próxima etapa...");
            await delay(5000); // ✅ Delay de 5 segundos após a requisição
        } catch (error) {
            console.error(`[Step 4] ❌ [Erro] Falha ao sincronizar detalhes das vendas:`, error.message || error);
            throw error;
        }
    }, empresa_id, access_token, refresh_token);

    console.log("✅ [Daily] Etapa 4: Detalhes das vendas sincronizados.");
}



// ==========================================

async function step5_syncPedidosCompra(empresa_id, access_token, refresh_token) {
    console.log("🔄 [Daily] Etapa 5: Sincronizar pedidos de compra...");

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

        await executeWithRetry(async (token) => {
            const url = `${process.env.SUPABASE_URL}/functions/v1/sync_pedido_compra`;
            const body = {
                empresa_id: Number(empresa_id), // ✅ Garantir que seja enviado como número
                access_token: token,
                id_bling_fornecedor: forn.id_bling
            };

            console.log(`📤 [Request] URL: ${url}, Body:`, body);

            try {
                const response = await global.fetch(url, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(body),
                });

                console.log(`📥 [Response] Status: ${response.status}`);

                if (!response.ok) {
                    const responseText = await response.text();
                    throw new Error(`Erro HTTP (${response.status}): ${responseText}`);
                }

                console.log(`✅ [Fornecedor ${forn.id_bling}] Sincronização concluída.`);
            } catch (error) {
                console.error(`❌ [Fornecedor ${forn.id_bling}] Erro durante a sincronização:`, error.message);
                throw error;
            }

            console.log(`⏸️ Aguardando 5 segundos antes do próximo fornecedor...`);
            await delay(5000); // ✅ Delay de 5 segundos após cada requisição
        }, empresa_id, access_token, refresh_token);

        console.log(`🔁 [Fornecedor ${index + 1}/${fornecedoresList.length}] Finalizado.`);
    }

    console.log("✅ [Fornecedores] Loop de sincronização concluído.");

    // 🔹 Sincronização de detalhes dos pedidos de compra
    console.log("🚀 [detalhes_pedido_compra] Iniciando sincronização...");
    await executeWithRetry(async (token) => {
        await syncWithPagination(
            `${process.env.SUPABASE_URL}/functions/v1/detalhes_pedido_compra`,
            { empresa_id: Number(empresa_id), access_token: token },
            empresa_id, refresh_token
        );
        console.log("✅ [detalhes_pedido_compra] Sincronização concluída.");
        console.log("⏸️ Aguardando 10 segundos antes da próxima etapa...");
        await delay(10000); // ✅ Delay de 10 segundos após a requisição
    }, empresa_id, access_token, refresh_token);

    // 🔹 Sincronização das últimas compras
    console.log("🚀 [sincronizar_ultimas_compras] Iniciando sincronização...");
    await executeWithRetry(async (token) => {
        await syncWithPagination(
            `${process.env.SUPABASE_URL}/functions/v1/sincronizar_ultimas_compras`,
            { empresa_id: Number(empresa_id), access_token: token },
            empresa_id, refresh_token
        );
        console.log("✅ [sincronizar_ultimas_compras] Sincronização concluída.");
        console.log("⏸️ Aguardando 5 segundos antes da próxima etapa...");
        await delay(5000); // ✅ Delay de 5 segundos após a requisição
    }, empresa_id, access_token, refresh_token);

    console.log("✅ [Daily] Etapa 5: Pedidos de Compra e Detalhes concluídos.");
}

// ==========================================

async function step6_syncNotasFiscais(empresa_id, access_token, refresh_token) {
    console.log("🔄 [Daily] Etapa 6: Sincronizar Notas Fiscais...");

    const today = new Date();
    const oneDayAgo = new Date(today);
    oneDayAgo.setDate(today.getDate() - 1);

    const data_inicial = formatDate(oneDayAgo);
    const data_final = formatDate(today);

    // ✅ Sincronizar últimas compras
    await executeWithRetry(async (token) => {
        const url = `${process.env.SUPABASE_URL}/functions/v1/sincronizar_ultimas_compras`;
        console.log(`📤 [Request] URL: ${url}`);

        await global.fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                access_token: token,
                start_date: data_inicial,
                end_date: data_final,
                empresa_id: Number(empresa_id),
            }),
        });

        console.log("✅ [sincronizar_ultimas_compras] Concluído.");
        await delay(50000);
    }, access_token, refresh_token);

    // ✅ Sincronizar detalhes das notas fiscais (com paginação)
    await executeWithRetry(async (token) => {
        const url = `${process.env.SUPABASE_URL}/functions/v1/detalhes_nota_fiscal`;
        console.log(`📤 [Request] URL: ${url}`);

        await callWithNextPage(url, {
            access_token: token,
            empresa_id: Number(empresa_id),
        });

        console.log("✅ [detalhes_nota_fiscal] Concluído.");
        await delay(50000);
    }, access_token, refresh_token);

    // ✅ Buscar chaves de acesso usando `data_emissao`
    console.log(`🔎 [Query] Buscando chaves de acesso de ${data_inicial} até ${data_final} usando data_emissao...`);

    const { data: chavesList, error } = await supabase
        .from("notas_fiscais")
        .select("chave_acesso")
        .eq("empresa_id", Number(empresa_id))
        .not("chave_acesso", "is", null)
        .gte("data_emissao", data_inicial)
        .lte("data_emissao", data_final); // ✅ Alterado para usar `data_emissao`

    if (error) throw error;

    console.log(`✅ [Query] Total de chaves encontradas: ${chavesList?.length || 0}`);

    // ✅ Loop para sincronizar detalhes das notas fiscais usando as chaves
    for (const nota of chavesList) {
        await executeWithRetry(async (token) => {
            const url = `${process.env.SUPABASE_URL}/functions/v1/detalhes_nota_fiscal_chave_acesso`;
            console.log(`📤 [Request] URL: ${url}, Chave: ${nota.chave_acesso}`);

            await global.fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    chave_acesso: nota.chave_acesso,
                    empresa_id: Number(empresa_id),
                }),
            });

            console.log(`✅ [Nota] Chave ${nota.chave_acesso} sincronizada.`);
            await delay(5000);
        }, access_token, refresh_token);
    }

    // ✅ Chamadas ao VALIDACAO_EAN_URL (sem delay)
    await executeWithRetry(async (token) => {
        const url = `${process.env.VALIDACAO_EAN_URL}/detalhamento_de_produtos/`;
        console.log(`📤 [Request] URL: ${url}`);

        await global.fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                empresa_id: Number(empresa_id),
                webhook_url: process.env.WEBHOOK_URL,
                data_inicio: data_inicial,
                data_fim: data_final,
            }),
        });

        console.log("✅ [detalhamento_de_produtos] Concluído.");
    }, access_token, refresh_token);

    await executeWithRetry(async (token) => {
        const url = `${process.env.VALIDACAO_EAN_URL}/vinculo_produto_por_fornecedor/`;
        console.log(`📤 [Request] URL: ${url}`);

        await global.fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                empresa_id: Number(empresa_id),
                webhook_url: process.env.WEBHOOK_URL_VINCULO,
            }),
        });

        console.log("✅ [vinculo_produto_por_fornecedor] Concluído.");
    }, access_token, refresh_token);

    console.log("✅ [Daily] Etapa 6: Notas fiscais e vinculações concluídas com sucesso.");
}

// =========================
// Fluxo Principal
// =========================

async function executeDailySync(empresa_id, access_token, refresh_token) {
    console.log(`\n🚀 [Daily] Iniciando sincronização para empresa ${empresa_id}`);

    access_token = await getValidBlingToken(Number(empresa_id), access_token, refresh_token);

    const today = new Date();
    const oneDayAgo = new Date(today);
    oneDayAgo.setDate(today.getDate() - 1);

    const data_inicial = formatDate(oneDayAgo);
    const data_final = formatDate(today);

    await step1_syncUltimosProdutos(empresa_id, access_token, refresh_token, data_inicial, data_final);
    await step2_syncFornecedores(empresa_id, access_token, refresh_token);
    await step3_syncVendasAtuais(empresa_id, access_token, refresh_token);
    await step4_syncDetalhesVendas(empresa_id, access_token, refresh_token);
    await step5_syncPedidosCompra(empresa_id, access_token, refresh_token);
    
    await step6_syncNotasFiscais(empresa_id, access_token, refresh_token);

    console.log("✅ [Daily] Todas as etapas de sincronização diária foram concluídas com sucesso!");
    return { success: true, message: "Daily sync completed" };
}

module.exports = {
    executeDailySync,
};
