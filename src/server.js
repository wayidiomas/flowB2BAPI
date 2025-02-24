// src/server.js
const express = require("express");
const cors = require("cors");
const swaggerUi = require("swagger-ui-express");
const swaggerJsDoc = require("swagger-jsdoc");

const app = express();
const { PORT } = require("./config");
const syncRoutes = require("./routes/syncRoutes");

// =========================
// ✅ CORS Middleware
// =========================
app.use(cors({
    origin: '*', // ✅ Permite todas as origens (ou especifique o domínio do seu frontend)
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true
}));

app.use(express.json());

// =========================
// Swagger Configuration
// =========================
const swaggerOptions = {
    definition: {
        openapi: "3.0.0",
        info: {
            title: "FlowB2BAPI",
            version: "1.0.0",
            description: "API para sincronização de dados do Bling e Supabase"
        },
        servers: [{ url: process.env.SERVER_URL || "http://localhost:3000" }] // ✅ Ajustado para o Render
    },
    apis: ["./src/routes/*.js"]
};

const swaggerDocs = swaggerJsDoc(swaggerOptions);
app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerDocs));

// =========================
// Rotas
// =========================
app.use("/api/sync", syncRoutes);

// =========================
// Inicialização do servidor
// =========================
const port = PORT || 3000;

app.listen(port, () => {
    console.log(`✅ Server running on port ${port}`);
    console.log(`📜 Swagger Docs available at ${process.env.SERVER_URL || `http://localhost:${port}`}/api-docs`);
});
