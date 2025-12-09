import { createClient } from 'https://esm.sh/@supabase/supabase-js';

// Função para aplicar delay
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function fetchProductsPage(page, accessToken, criterio = 2, retryCount = 3) {
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${accessToken}`,
  };

  for (let attempt = 1; attempt <= retryCount; attempt++) {
    try {
      console.log(`Fetching products from Bling API, page: ${page}, criterio: ${criterio}, attempt: ${attempt}`);
      await delay(333); // Delay antes de cada requisição para limitar a 3 chamadas/s

      const response = await fetch(`https://www.bling.com.br/Api/v3/produtos?pagina=${page}&limite=100&criterio=${criterio}`, { headers });
      const data = await response.json();

      // Caso de 429 - Too Many Requests
      if (response.status === 429) {
        console.warn(`429 Too Many Requests on page ${page}, criterio ${criterio}, attempt: ${attempt}`);
        if (attempt < retryCount) {
          await delay(5000); // Espera 5 segundos antes de tentar novamente
          continue; // Tenta novamente
        } else {
          console.error(`429 Too Many Requests - Reached max retry attempts on page ${page}`);
          return { products: [], rawData: null, page: page };
        }
      }

      if (!data.data || data.data.length === 0) {
        console.log(`No products data found on page ${page}, criterio ${criterio}`);
        return { products: [], rawData: data, page: page };
      }

      console.log(`Fetched ${data.data.length} products from page ${page}, criterio ${criterio}`);
      return { products: data.data, rawData: data, page: page };

    } catch (error) {
      console.error(`Error fetching products on page ${page}, criterio ${criterio}, attempt: ${attempt}`, error);
      if (attempt === retryCount) {
        throw error;
      }
    }
  }

  return { products: [], rawData: null, page: page };
}

async function processProductsPage(accessToken, empresaId, page, criterio = 2) {
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_ANON_KEY') ?? '',
  );

  const { products, rawData, page: returnedPage } = await fetchProductsPage(page, accessToken, criterio);

  if (products.length === 0) {
    return { status: false, rawData: rawData, page: returnedPage };
  }

  for (const product of products) {
    if (!product.id) {
      console.warn('Product ID is undefined:', product);
      continue;
    }

    const productData = {
      nome: product.nome,
      codigo: product.codigo,
      preco: product.preco,
      tipo: product.tipo,
      situacao: product.situacao,
      formato: product.formato,
      descricao_curta: product.descricaoCurta,
      imagem_url: product.imagemURL,
      empresa_id: empresaId,
      id_produto_bling: product.id,
    };

    // Se produto é INATIVO: apenas UPDATE (não insere novos)
    if (product.situacao === 'I') {
      console.log(`Updating INACTIVE product ID: ${product.id}, Empresa ID: ${empresaId}`);

      const { error } = await supabase
        .from('produtos')
        .update(productData)
        .eq('id_produto_bling', product.id)
        .eq('empresa_id', empresaId);

      if (error) {
        console.error(`Error updating inactive product with ID: ${product.id}`, error);
      } else {
        console.log(`Successfully updated inactive product ID: ${product.id}`);
      }
    }
    // Se produto é ATIVO: UPSERT (insere ou atualiza)
    else {
      console.log(`Upserting ACTIVE product ID: ${product.id}, Empresa ID: ${empresaId}`);

      const { error } = await supabase
        .from('produtos')
        .upsert(productData, { onConflict: ['id_produto_bling', 'empresa_id'] });

      if (error) {
        console.error(`Error upserting active product with ID: ${product.id}`, error);
      } else {
        console.log(`Successfully upserted active product ID: ${product.id}`);
      }
    }
  }

  return { status: true, quantidade: products.length, rawData: rawData, page: returnedPage };
}

Deno.serve(async (req) => {
  try {
    const { access_token, empresa_id, page, criterio = 2 } = await req.json();
    console.log('Starting process with params:', { access_token, empresa_id, page, criterio });
    const result = await processProductsPage(access_token, empresa_id, page, criterio);

    return new Response(JSON.stringify(result), {
      headers: { 'Content-Type': 'application/json' },
      status: 200,
    });
  } catch (err) {
    console.error('Error in initial request handling:', err);
    return new Response(String(err?.message ?? err), { status: 500 });
  }
});
