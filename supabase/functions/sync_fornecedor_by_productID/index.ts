import { createClient } from 'https://esm.sh/@supabase/supabase-js';
import { serve } from "https://deno.land/std@0.114.0/http/server.ts";

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const fetchSupplierDetails = async (productId: string, headers: HeadersInit, retryCount = 3) => {
  for (let attempt = 1; attempt <= retryCount; attempt++) {
    try {
      const response = await fetch(`https://www.bling.com.br/Api/v3/produtos/fornecedores?idProduto=${productId}`, { headers });
      console.log(`Response from Bling for product ID: ${productId} on attempt ${attempt}:`, response.status);

      if (response.status === 429) {
        console.warn(`Too many requests for product ID: ${productId}. Attempt ${attempt} of ${retryCount}`);
        await delay(5000);
        continue;
      }

      const result = await response.json();
      console.log(`Data from Bling for product ID: ${productId} on attempt ${attempt}:`, result);

      if (!result || !result.data || result.data.length === 0) {
        console.warn(`[WARN] No supplier data found for product ID: ${productId}`);
        return null;
      }

      return result.data;
    } catch (error) {
      console.error(`[ERROR] Error fetching supplier details for product ID: ${productId} on attempt ${attempt}`, error);
      if (attempt === retryCount) return null;
      await delay(5000);
    }
  }
  return null;
};

const ensureSupplierExists = async (supabase: any, supplier: any, empresa_id: number) => {
  const supplierIdBling = supplier.id;

  const { data: existingSupplier, error: fetchSupplierError } = await supabase
    .from('fornecedores')
    .select('id')
    .eq('id_bling', supplierIdBling)
    .eq('empresa_id', empresa_id);

  if (fetchSupplierError) {
    console.error('[ERROR] Error fetching supplier from Supabase:', fetchSupplierError);
    throw fetchSupplierError;
  }

  if (!existingSupplier || existingSupplier.length === 0) {
    console.log(`[INFO] Inserting new supplier with Bling ID: ${supplierIdBling}`);
    const { error: insertSupplierError } = await supabase
      .from('fornecedores')
      .insert({
        id_bling: supplierIdBling,
        nome: supplier.nome,
        empresa_id: empresa_id,
      });

    if (insertSupplierError) {
      console.error('[ERROR] Error inserting supplier into Supabase:', insertSupplierError);
      return null;
    }

    const { data: newSupplier, error: fetchNewSupplierError } = await supabase
      .from('fornecedores')
      .select('id')
      .eq('id_bling', supplierIdBling)
      .eq('empresa_id', empresa_id);

    if (fetchNewSupplierError || !newSupplier || newSupplier.length === 0) {
      console.error('[ERROR] Error verifying new supplier in Supabase:', fetchNewSupplierError || 'Supplier not found');
      return null;
    }

    console.log(`[OK] New supplier inserted with ID: ${newSupplier[0].id}`);
    return newSupplier[0].id;
  }

  console.log(`[OK] Supplier with Bling ID: ${supplierIdBling} already exists with ID: ${existingSupplier[0].id}`);
  return existingSupplier[0].id;
};

const processSupplierDetails = async (access_token: string, empresa_id: number, limit: number, page: number) => {
  const headers = new Headers({
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${access_token}`,
  });

  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  console.log(`[INFO] Fetching products from Supabase for page ${page} with limit ${limit}`);
  const { data: products, error } = await supabase
    .from('produtos')
    .select('id, id_produto_bling')
    .eq('empresa_id', empresa_id)
    .range((page - 1) * limit, page * limit - 1);

  if (error) {
    console.error('[ERROR] Error fetching products from Supabase:', error);
    throw error;
  }

  if (!products || products.length === 0) {
    console.log('[WARN] No products found for the given page and limit');
    return { nextPage: null, quantity: 0 };
  }

  console.log(`[OK] Fetched ${products.length} products from Supabase`);
  const productIds = products.map(product => product.id_produto_bling);
  console.log('Product IDs to process:', productIds);

  for (const product of products) {
    try {
      console.log(`[INFO] Fetching supplier details for product ID: ${product.id_produto_bling}`);
      const supplierDetails = await fetchSupplierDetails(product.id_produto_bling, headers);
      if (!supplierDetails) {
        console.log(`[WARN] No supplier details found for product ID: ${product.id_produto_bling}`);
        continue;
      }

      console.log(`[OK] Supplier details fetched for product ID: ${product.id_produto_bling}`);
      for (const detail of supplierDetails) {
        const supplierSupabaseId = await ensureSupplierExists(supabase, detail.fornecedor, empresa_id);
        if (!supplierSupabaseId) {
          console.error(`[ERROR] Supplier with Bling ID ${detail.fornecedor.id} could not be verified.`);
          continue;
        }

        // Log do codigo do fornecedor recebido do Bling
        console.log(`[INFO] Supplier product code from Bling: ${detail.produtoCodigo || detail.codigo || 'N/A'}`);

        console.log(`[INFO] Upserting supplier-product relationship for product ID: ${product.id} and supplier ID: ${supplierSupabaseId}`);
        const { error: upsertRelationshipError } = await supabase
          .from('fornecedores_produtos')
          .upsert({
            fornecedor_id: supplierSupabaseId,
            produto_id: product.id,
            valor_de_compra: detail.precoCompra,
            qtd_ultima_compra: detail.qtdUltimaCompra,
            precocusto: detail.precoCusto,
            empresa_id: empresa_id,
            // NOVO: Salva o codigo do produto no sistema do fornecedor
            codigo_fornecedor: detail.produtoCodigo || detail.codigo || null,
          });

        if (upsertRelationshipError) {
          console.error('[ERROR] Error upserting supplier-product relationship:', upsertRelationshipError);
        } else {
          console.log(`[OK] Successfully upserted supplier-product relationship for product ID: ${product.id} and supplier ID: ${supplierSupabaseId} with codigo_fornecedor: ${detail.produtoCodigo || detail.codigo || 'N/A'}`);
        }
      }

      await delay(333); // Delay para respeitar o rate limit
    } catch (error) {
      console.error(`[ERROR] Error processing product ID: ${product.id_produto_bling}. Error:`, error.message);
    }
  }

  return { nextPage: products.length === limit ? page + 1 : null, quantity: products.length };
};

serve(async (req) => {
  try {
    const { access_token, empresa_id, limit = 100, page = 1 } = await req.json();

    if (!access_token || !empresa_id) {
      throw new Error('[WARN] Access token and empresa ID are required');
    }

    console.log('[INFO] Starting processSupplierDetails...');

    const { data: products, error } = await supabase
      .from('produtos')
      .select('id, id_produto_bling')
      .eq('empresa_id', empresa_id)
      .range((page - 1) * limit, page * limit - 1);

    if (error) {
      console.error('[ERROR] Error fetching products from Supabase:', error);
      throw error;
    }

    if (!products || products.length === 0) {
      console.log('[WARN] No products data');
      return new Response(JSON.stringify({
        message: 'No products data',
        next_page: null,
        quantity: 0
      }), {
        headers: { 'Content-Type': 'application/json' },
        status: 200,
      });
    }

    console.log(`[OK] Fetched ${products.length} products from Supabase on page ${page}`);

    const nextPage = products.length === limit ? page + 1 : null;

    const response = new Response(JSON.stringify({
      message: 'Supplier details update started',
      next_page: nextPage,
      quantity: products.length,
      product_ids: products.map(product => product.id_produto_bling)
    }), {
      headers: { 'Content-Type': 'application/json' },
      status: 200,
    });

    processSupplierDetails(access_token, empresa_id, limit, page).catch(error => {
      console.error('[ERROR] Error in background processing:', error);
    });

    return response;
  } catch (error) {
    console.error('[ERROR] Error handling request:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      headers: { 'Content-Type': 'application/json' },
      status: 500,
    });
  }
});
