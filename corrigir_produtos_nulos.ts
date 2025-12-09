// Edge Function: corrigir_produtos_nulos (agrupa por empresa e aplica rate-limit por token)
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.48.1'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
const DEFAULT_LIMIT = 1000
const RATE_LIMIT_DELAY_MS = 350 // ~3 req/s por token
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

type ProdutoPendencia = { id: number; id_produto_bling: string | null; empresa_id: number | null }
type TokenRow = { access_token: string | null }
type BlingProduct = { unidade?: string | null; itensPorCaixa?: number | null }

type ProdutoGroup = { empresa_id: number; itens: ProdutoPendencia[] }

function getSupabaseClient(): SupabaseClient {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('ENV faltando', { SUPABASE_URL: !!SUPABASE_URL, SERVICE_KEY: !!SUPABASE_SERVICE_ROLE_KEY })
  }
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false }
  })
}

async function fetchPendingProducts(supabase: SupabaseClient, limit: number): Promise<ProdutoPendencia[]> {
  const { data, error } = await supabase
    .from('produtos')
    .select('id, id_produto_bling, empresa_id')
    .or('unidade.is.null,itens_por_caixa.is.null,itens_por_caixa.eq.0')
    .not('id_produto_bling', 'is', null)
    .limit(limit)

  if (error) {
    console.error('Erro select pendentes', { error: error.message })
    throw error
  }
  console.log('Pendentes encontrados', data?.length ?? 0)
  return data ?? []
}

async function getTokenForEmpresa(supabase: SupabaseClient, empresa_id: number): Promise<string | null> {
  const { data, error } = await supabase
    .from('bling_tokens')
    .select('access_token')
    .eq('empresa_id', empresa_id)
    .single()

  if (error) {
    console.error('Erro ao buscar token', { empresa_id, error: error.message })
    return null
  }
  const token = (data as TokenRow | null)?.access_token ?? null
  if (!token) console.warn('Token vazio para empresa', empresa_id)
  return token
}

async function fetchBlingProduct(idProdutoBling: string, token: string): Promise<BlingProduct | null> {
  try {
    const resp = await fetch(`https://www.bling.com.br/Api/v3/produtos/${idProdutoBling}`, {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }
    })
    if (!resp.ok) {
      console.error('Erro HTTP ao buscar produto', { idProdutoBling, status: resp.status })
      return null
    }
    const json = await resp.json()
    return (json?.data ?? null) as BlingProduct | null
  } catch (error) {
    console.error('Erro fetch produto Bling', { idProdutoBling, error: (error as Error).message })
    return null
  }
}

async function updateProdutoDetalhes(
  supabase: SupabaseClient,
  produto: ProdutoPendencia,
  detalhes: BlingProduct
): Promise<boolean> {
  const unidade = (detalhes.unidade ?? '').trim() || 'UN'
  const itens = detalhes.itensPorCaixa && detalhes.itensPorCaixa > 0 ? detalhes.itensPorCaixa : 1
  const updates: Record<string, unknown> = { unidade, itens_por_caixa: itens }

  const { error } = await supabase.from('produtos').update(updates).eq('id', produto.id)
  if (error) {
    console.error('Erro ao atualizar produto', { produto_id: produto.id, error: error.message })
    return false
  }
  return true
}

function groupByEmpresa(pendentes: ProdutoPendencia[]): ProdutoGroup[] {
  const map = new Map<number, ProdutoPendencia[]>()
  for (const p of pendentes) {
    if (!p.empresa_id) continue
    if (!map.has(p.empresa_id)) map.set(p.empresa_id, [])
    map.get(p.empresa_id)!.push(p)
  }
  return Array.from(map.entries()).map(([empresa_id, itens]) => ({ empresa_id, itens }))
}

Deno.serve(async (req) => {
  try {
    const body = await req.json().catch(() => ({} as Record<string, unknown>))
    const parsed = Number(body.limit)
    const limit = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, DEFAULT_LIMIT) : DEFAULT_LIMIT

    const supabase = getSupabaseClient()
    const pendentes = await fetchPendingProducts(supabase, limit)

    if (!pendentes.length) {
      console.log('Nenhum pendente no filtro')
      return new Response(JSON.stringify({ message: 'Nenhum produto pendente', processed: 0 }), {
        headers: { 'Content-Type': 'application/json' },
        status: 200
      })
    }

    const grupos = groupByEmpresa(pendentes)
    console.log('Grupos por empresa', grupos.map((g) => ({ empresa_id: g.empresa_id, qtd: g.itens.length })))

    let success = 0
    let skipped = 0
    let failures = 0

    for (const grupo of grupos) {
      const token = await getTokenForEmpresa(supabase, grupo.empresa_id)
      if (!token) {
        failures += grupo.itens.length
        continue
      }

      for (const prod of grupo.itens) {
        if (!prod.id_produto_bling) {
          skipped++
          console.warn('Produto sem id_produto_bling', prod)
          continue
        }

        const detalhes = await fetchBlingProduct(prod.id_produto_bling, token)
        if (!detalhes) {
          failures++
          continue
        }

        const updated = await updateProdutoDetalhes(supabase, prod, detalhes)
        if (updated) success++
        else skipped++

        await delay(RATE_LIMIT_DELAY_MS) // rate-limit por token
      }
    }

    return new Response(
      JSON.stringify({ message: 'Execução concluída', processed: pendentes.length, success, skipped, failures }),
      { headers: { 'Content-Type': 'application/json' }, status: 200 }
    )
  } catch (error) {
    console.error('Erro na função corrigir_produtos_nulos', error)
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      headers: { 'Content-Type': 'application/json' },
      status: 500
    })
  }
})
