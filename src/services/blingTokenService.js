const axios = require("axios");
const FormData = require("form-data");
const supabase = require("./supabaseService");

// =========================
// Função para Inserir ou Atualizar Token no Supabase
// =========================

async function upsertBlingToken(empresa_id, access_token, refresh_token, expires_at) {
  try {
    console.log(`💾 Inserindo ou atualizando token para empresa ${empresa_id}...`);

    const { error } = await supabase.from("bling_tokens").upsert(
      {
        empresa_id,
        access_token,
        refresh_token,
        expires_at,
      },
      { onConflict: ["empresa_id"] } // Garante atualização se já existir
    );

    if (error) throw error;

    console.log(`✅ Token salvo com sucesso.`);
  } catch (error) {
    console.error("❌ Erro ao salvar token do Bling:", error.message || error);
    throw error;
  }
}

// =========================
// Função para Atualizar o Token Usando refresh_token
// =========================

async function refreshBlingToken(empresa_id, currentRefreshToken) {
  try {
    console.log(`🔄 Atualizando token para empresa ${empresa_id}...`);

    const formData = new FormData();
    formData.append("grant_type", "refresh_token");
    formData.append("refresh_token", currentRefreshToken);

    const response = await axios.post(
      "https://www.bling.com.br/Api/v3/oauth/token",
      formData,
      {
        headers: {
          ...formData.getHeaders(),
          Accept: "1.0",
          Authorization: `Basic ${process.env.BLING_AUTHORIZATION}`,
        },
      }
    );

    if (response.status !== 200) {
      throw new Error(`Erro na atualização do token: ${response.statusText}`);
    }

    const { access_token, refresh_token, expires_in } = response.data;
    const expires_at = new Date(Date.now() + expires_in * 1000);

    console.log(`✅ Novo access_token obtido: ${access_token}`);

    // Atualiza ou insere o token no Supabase
    await upsertBlingToken(empresa_id, access_token, refresh_token, expires_at);

    return { access_token, refresh_token, expires_at };
  } catch (error) {
    console.error("❌ Erro ao atualizar token do Bling:", error.message || error);
    throw error;
  }
}

// =========================
// Função para Retornar o Token Válido
// =========================

async function getValidBlingToken(empresa_id, accessToken = null, refresh_token = null) {
  try {
    console.log(`🔎 Validando token para empresa ${empresa_id}...`);

    const { data, error } = await supabase
      .from("bling_tokens")
      .select("access_token, refresh_token, expires_at")
      .eq("empresa_id", empresa_id)
      .maybeSingle(); // Permite null se não encontrar

    // Se não existir, insere usando os dados recebidos no primeiro uso
    if (!data) {
      console.log("💾 Token não encontrado. Inserindo no banco de dados...");
      await upsertBlingToken(empresa_id, accessToken, refresh_token, new Date(Date.now() + 3600 * 1000));
      return accessToken; // Retorna o token enviado
    }

    // Se o token estiver expirado, atualiza
    const tokenExpirado = new Date(data.expires_at) <= new Date();
    if (tokenExpirado) {
      console.log("💡 Token expirado. Atualizando...");
      const newToken = await refreshBlingToken(empresa_id, refresh_token || data.refresh_token);
      return newToken.access_token;
    }

    console.log("✅ Token válido encontrado.");
    return data.access_token;
  } catch (error) {
    console.error("❌ Erro ao validar token do Bling:", error.message || error);
    throw error;
  }
}

module.exports = {
  refreshBlingToken,
  getValidBlingToken,
  upsertBlingToken, // ✅ Exportado para outros usos
};
