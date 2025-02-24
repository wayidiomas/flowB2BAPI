// src/config/corsConfig.js 
const cors = require('cors');

const corsOptions = {
    origin: '*', // ✅ Permite todas as origens
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type'],
    credentials: false, // ❌ Desativado o uso de cookies e cabeçalhos de autenticação
    optionsSuccessStatus: 204 // Para navegadores antigos (IE11)
};

module.exports = cors(corsOptions);
