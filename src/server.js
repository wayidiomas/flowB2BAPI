// src/server.js
const express = require("express");
const swaggerUi = require("swagger-ui-express");
const swaggerJsDoc = require("swagger-jsdoc");

const app = express();
const { PORT } = require("./config");
const syncRoutes = require("./routes/syncRoutes");

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
        servers: [{ url: "http://localhost:3000" }]
    },
    apis: ["./src/routes/*.js"] // Documenta automaticamente as rotas da pasta routes
};

const swaggerDocs = swaggerJsDoc(swaggerOptions);
app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerDocs));

// =========================
// Rotas
// =========================

// Rotas de sincronização (prefixo /api/sync)
app.use("/api/sync", syncRoutes);

// =========================
// Inicialização do servidor
// =========================
const port = PORT || 3000;

app.listen(port, () => {
    console.log(`✅ Server running on port ${port}`);
    console.log(`📜 Swagger Docs available at http://localhost:${port}/api-docs`);
});
