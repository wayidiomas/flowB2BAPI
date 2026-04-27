// scripts/backup_data.js
// Exporta produtos, fornecedores e fornecedores_produtos para arquivos JSON locais.
// Saída: backups/<tabela>_<YYYY-MM-DD-HHmm>.json + manifest_<...>.json
require("dotenv").config();
const path = require("path");
const fs = require("fs");
const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error("✗ SUPABASE_URL ou SUPABASE_KEY ausentes no .env");
    process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false }
});

const TABELAS = [
    { nome: "produtos", orderBy: "id" },
    { nome: "fornecedores", orderBy: "id" },
    { nome: "fornecedores_produtos", orderBy: "produto_id" }
];
const PAGE_SIZE = 1000;

const BACKUP_DIR = path.resolve(__dirname, "..", "backups");
if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

function timestamp() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

async function backupTable({ nome, orderBy }, ts) {
    const t0 = Date.now();
    const all = [];
    let from = 0;
    let totalCount = null;

    process.stdout.write(`  ${nome}: `);

    while (true) {
        const { data, error, count } = await supabase
            .from(nome)
            .select("*", { count: from === 0 ? "exact" : null })
            .order(orderBy, { ascending: true })
            .range(from, from + PAGE_SIZE - 1);

        if (error) {
            console.error(`\n✗ erro em ${nome}: ${error.message}`);
            throw error;
        }

        if (from === 0 && count !== null) totalCount = count;

        if (!data || data.length === 0) break;
        all.push(...data);
        process.stdout.write(`${all.length}${totalCount ? "/" + totalCount : ""} `);

        if (data.length < PAGE_SIZE) break;
        from += PAGE_SIZE;
    }

    const fileName = `${nome}_${ts}.json`;
    const filePath = path.join(BACKUP_DIR, fileName);
    fs.writeFileSync(filePath, JSON.stringify(all, null, 2), "utf8");
    const sizeKB = Math.round(fs.statSync(filePath).size / 1024);

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`✓ ${all.length} linhas | ${sizeKB} KB | ${elapsed}s`);

    return { tabela: nome, file: fileName, rows: all.length, sizeKB };
}

async function main() {
    const ts = timestamp();
    console.log(`\n► Backup ${ts}\n`);

    const resumo = [];
    for (const tabela of TABELAS) {
        try {
            resumo.push(await backupTable(tabela, ts));
        } catch (err) {
            resumo.push({ tabela: tabela.nome, error: err.message });
        }
    }

    const manifest = {
        timestamp: new Date().toISOString(),
        supabase_url: SUPABASE_URL,
        tabelas: resumo
    };
    const manifestPath = path.join(BACKUP_DIR, `manifest_${ts}.json`);
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

    console.log(`\n✓ Manifest: ${manifestPath}\n`);
}

main().catch((err) => {
    console.error("\n✗ Backup falhou:", err);
    process.exit(1);
});
