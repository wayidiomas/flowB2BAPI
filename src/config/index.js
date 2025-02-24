require("dotenv").config(); // carrega variáveis definidas no arquivo .env

module.exports = {
  PORT: process.env.PORT || 3000,
  BLING_REFRESH_TOKEN_EXPIRE: process.env.BLING_REFRESH_TOKEN_EXPIRE || 3600,
  SUPABASE_URL: process.env.SUPABASE_URL || "",
  SUPABASE_KEY: process.env.SUPABASE_KEY || "",
  BLING_AUTHORIZATION: process.env.BLING_AUTHORIZATION || "",
  WEBHOOK_URL: process.env.WEBHOOK_URL || "",
  WEBHOOK_URL_VINCULO: process.env.WEBHOOK_URL_VINCULO || "",
  VALIDACAO_EAN_URL: process.env.VALIDACAO_EAN_URL || "",
  // Adicione outras configs, se necessário
};
