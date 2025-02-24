// src/config/corsConfig.js
const cors = require('cors');

// Usa SERVER_URL como a origem principal ou localhost em desenvolvimento
const allowedOrigins = [process.env.SERVER_URL || 'http://localhost:3000'];

const corsOptions = {
    origin: (origin, callback) => {
        if (!origin || allowedOrigins.includes(origin)) {
            callback(null, true); // Permite chamadas de origens listadas ou chamadas internas (ex: Postman)
        } else {
            callback(new Error('Not allowed by CORS'));
        }
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type'],
    credentials: false, // ❌ Removida a autenticação
    optionsSuccessStatus: 204 // Para navegadores antigos (IE11)
};

module.exports = cors(corsOptions);
