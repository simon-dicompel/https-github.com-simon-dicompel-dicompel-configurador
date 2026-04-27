import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";
import sql from 'mssql';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuração MSSQL baseada nos dados fornecidos
const dbConfig = {
    user: process.env.DB_USER || 'adminsql',
    password: process.env.DB_PASS || process.env.DB_PASSWORD || 'Xaviera%%',
    server: process.env.DB_HOST || 'configurador-produto-sql.database.windows.net', // Nome do servidor Azure SQL
    database: process.env.DB_NAME || 'configurador-produto',
    options: {
        encrypt: true,
        trustServerCertificate: false
    },
    pool: {
        max: 5,
        min: 0,
        idleTimeoutMillis: 30000
    }
};

async function startServer() {
    const app = express();
    const PORT = 3000;

    app.use(express.json());

    // Pool de conexão
    let pool: sql.ConnectionPool | null = null;
    
    try {
        pool = await sql.connect(dbConfig);
        console.log('>> Sucesso: Conectado ao Azure SQL Server (MSSQL)');
    } catch (err: any) {
        console.error('>> ERRO AO CONECTAR AO AZURE SQL SERVER:', err.message);
        if (err.message.includes('paused')) {
            console.warn('>> ATENÇÃO: O banco de dados está pausado (Cota Mensal atingida).');
        }
    }

    // --- API ROUTES ---
    
    app.get("/api/health", async (req, res) => {
        const status = {
            database: 'Microsoft SQL Server',
            connected: pool?.connected || false,
            error: null as string | null
        };
        if (pool?.connected) {
            try { await pool.request().query('SELECT 1'); } 
            catch (err: any) { status.error = err.message; }
        } else {
            status.error = "Servidor SQL desconectado ou pausado.";
        }
        res.json(status);
    });

    app.get("/api/products", async (req, res) => {
        if (!pool?.connected) return res.status(503).json({ error: "Banco de dados pausado ou offline." });
        try {
            const result = await pool.request().query('SELECT * FROM products ORDER BY description');
            res.json(result.recordset);
        } catch (err) {
            console.error("DB Error:", err);
            res.status(500).json({ error: "Erro ao buscar produtos" });
        }
    });

    app.post("/api/auth/login", async (req, res) => {
        const { email, password } = req.body;
        const normalizedEmail = email?.toLowerCase().trim();
        
        // Login Admin Mestre (Fallback se o DB estiver pausado)
        if (normalizedEmail === 'admin@dicompel.com.br' && password === 'Sigilo!@#2025') {
            return res.json({ id: '999', email: normalizedEmail, name: 'Admin Master', role: 'ADMIN' });
        }

        if (!pool?.connected) return res.status(503).json({ error: "Banco offline. Use credenciais mestre." });
        
        try {
            const result = await pool.request()
                .input('email', sql.NVarChar, normalizedEmail)
                .input('password', sql.NVarChar, password)
                .query('SELECT * FROM profiles WHERE email = @email AND password = @password');
                
            if (result.recordset.length > 0) {
                const user = result.recordset[0];
                res.json({ id: user.id, email: user.email, name: user.name, role: user.role });
            } else {
                res.status(401).json({ error: "Credenciais inválidas" });
            }
        } catch (err) {
            res.status(500).json({ error: "Erro na autenticação" });
        }
    });

    app.get("/api/users", async (req, res) => {
        if (!pool?.connected) return res.status(503).json({ error: "DB offline" });
        try {
            const result = await pool.request().query('SELECT id, email, name, role FROM profiles ORDER BY name');
            res.json(result.recordset);
        } catch (err) {
            res.status(500).json({ error: "Erro ao buscar usuários" });
        }
    });

    app.post("/api/users", async (req, res) => {
        if (!pool?.connected) return res.status(503).json({ error: "DB offline" });
        const { name, email, role, password } = req.body;
        try {
            const result = await pool.request()
                .input('name', sql.NVarChar, name)
                .input('email', sql.NVarChar, email)
                .input('role', sql.NVarChar, role)
                .input('password', sql.NVarChar, password)
                .query('INSERT INTO profiles (name, email, role, password) OUTPUT INSERTED.id, INSERTED.name, INSERTED.email, INSERTED.role VALUES (@name, @email, @role, @password)');
            res.json(result.recordset[0]);
        } catch (err) {
            res.status(500).json({ error: "Erro ao criar usuário" });
        }
    });

    // --- VITE MIDDLEWARE ---
    if (process.env.NODE_ENV !== "production") {
        const vite = await createViteServer({
            server: { middlewareMode: true },
            appType: "spa",
        });
        app.use(vite.middlewares);
    } else {
        const distPath = path.join(process.cwd(), 'dist');
        app.use(express.static(distPath));
        app.get('*', (req, res) => {
            res.sendFile(path.join(distPath, 'index.html'));
        });
    }

    app.listen(PORT, "0.0.0.0", () => {
        console.log(`Servidor rodando em http://localhost:${PORT}`);
    });
}

startServer();
