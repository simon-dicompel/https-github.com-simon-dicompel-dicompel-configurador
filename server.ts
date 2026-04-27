import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";
import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // Configuração do Banco de Dados Azure
  const hasDbConfig = !!(process.env.DB_HOST && process.env.DB_USER);
  
  if (hasDbConfig) {
    console.log("Variáveis de Banco Detectadas:");
    console.log("- Host:", process.env.DB_HOST);
    console.log("- User:", process.env.DB_USER);
    
    // Alerta específico para Azure
    if (process.env.DB_HOST?.includes('postgres.database.azure.com') && !process.env.DB_USER?.includes('@')) {
      console.warn(">> AVISO CRÍTICO: Detectado Azure PostgreSQL mas o DB_USER não contém '@servidor'.");
      console.warn(">> Exemplo: se o host é 'meu-db.postgres.database.azure.com', o usuário deve ser 'admin@meu-db'.");
    }
    
    console.log("- Database:", process.env.DB_NAME);
    console.log("- Password:", (process.env.DB_PASS || process.env.DB_PASSWORD) ? '********' : 'NÃO DEFINIDA');
    console.log("- Port:", process.env.DB_PORT || '5432');
  } else {
    console.log("Atenção: Variáveis de Banco de Dados Azure não configuradas totalmente (DB_HOST e DB_USER são obrigatórios).");
  }

  const pool = new pg.Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASS || process.env.DB_PASSWORD,
    port: parseInt(process.env.DB_PORT || "5432"),
    ssl: process.env.DB_SSL === 'true' || process.env.DB_SSL === undefined ? { rejectUnauthorized: false } : false,
    max: 5, // Muito baixo para minimizar quedas no Tier Basic do Azure
    idleTimeoutMillis: 10000, // Fecha conexões ociosas rapidamente
    connectionTimeoutMillis: 20000,
    keepAlive: true,
    statement_timeout: 30000,
    application_name: 'dicompel_catalog'
  });

  pool.on('connect', (client) => {
    console.log('>> Cliente PostgreSQL conectado.');
  });

  pool.on('error', (err) => {
    console.error('>> ERRO NO POOL:', err.message);
    if (err.message.includes('terminated unexpectedly') || err.message.includes('Connection terminated')) {
      console.warn('>> O Azure encerrou a conexão. Possíveis causas: 1. Firewall bloqueando o IP (ative "Allow Azure Services"), 2. Usuário sem @servidor, 3. Inatividade agressiva do Azure.');
    }
  });

  // Testar conexão inicial com log detalhado
  if (hasDbConfig) {
    pool.query('SELECT NOW()', (err, res) => {
      if (err) {
        console.error('>> FALHA NA CONEXÃO INICIAL COM AZURE:', err.message);
        if (err.message.includes('authentication failed')) {
          console.error('>> VERIFIQUE: O usuário deve ser no formato: usuario@servidor');
        }
      } else {
        console.log('>> CONEXÃO COM AZURE OK:', res.rows[0].now);
      }
    });
  }

  // --- API ROUTES ---
  
  app.get("/api/health", async (req, res) => {
    const status = {
      database: hasDbConfig ? 'configurado' : 'pendente',
      connection: false,
      error: null as string | null
    };

    if (hasDbConfig) {
      try {
        await pool.query('SELECT 1');
        status.connection = true;
      } catch (err: any) {
        status.error = err.message;
      }
    }

    res.json(status);
  });

  app.get("/api/products", async (req, res) => {
    if (!hasDbConfig) {
      return res.status(503).json({ error: "Banco de dados não configurado. Use .env para configurar a Azure." });
    }
    try {
      const result = await pool.query('SELECT * FROM products ORDER BY description');
      res.json(result.rows);
    } catch (err) {
      console.error("DB Error:", err);
      res.status(500).json({ error: "Erro ao buscar produtos no banco de dados" });
    }
  });

  app.post("/api/auth/login", async (req, res) => {
    const { email, password } = req.body;
    const normalizedEmail = email?.toLowerCase().trim();
    console.log(`>> Tentativa de login para: ${normalizedEmail}`);

    // Fallback para Administrador mestre
    if (normalizedEmail === 'admin@dicompel.com.br' && password === 'Sigilo!@#2025') {
      console.log(">> Login mestre aceito.");
      return res.json({ 
        id: '999', 
        email: normalizedEmail, 
        name: 'Administrador Dicompel', 
        role: 'ADMIN' 
      });
    }

    if (!hasDbConfig) {
      console.log(">> Azure DB não configurado e falhou no login mestre.");
      return res.status(503).json({ error: "Azure DB não configurado. Use as credenciais padrão: admin@dicompel.com.br / Sigilo!@#2025" });
    }
    try {
      const result = await pool.query('SELECT * FROM profiles WHERE email = $1 AND password = $2', [email, password]);
      if (result.rows.length > 0) {
        const user = result.rows[0];
        res.json({ id: user.id, email: user.email, name: user.name, role: user.role });
      } else {
        res.status(401).json({ error: "Credenciais inválidas" });
      }
    } catch (err) {
      console.error("Auth error:", err);
      res.status(500).json({ error: "Erro de conexão com o banco de dados" });
    }
  });

  // Users
  app.get("/api/users", async (req, res) => {
    if (!hasDbConfig) return res.status(503).json({ error: "DB offline" });
    try {
      const result = await pool.query('SELECT id, email, name, role FROM profiles ORDER BY name');
      res.json(result.rows);
    } catch (err) {
      res.status(500).json({ error: "Erro ao buscar usuários" });
    }
  });

  app.post("/api/users", async (req, res) => {
    if (!hasDbConfig) return res.status(503).json({ error: "DB offline" });
    const { name, email, role, password } = req.body;
    try {
      const result = await pool.query(
        'INSERT INTO profiles (name, email, role, password) VALUES ($1, $2, $3, $4) RETURNING id, name, email, role',
        [name, email, role, password]
      );
      res.json(result.rows[0]);
    } catch (err) {
      res.status(500).json({ error: "Erro ao criar usuário" });
    }
  });

  app.put("/api/users/:id", async (req, res) => {
    if (!hasDbConfig) return res.status(503).json({ error: "DB offline" });
    const { id } = req.params;
    const { name, email, role } = req.body;
    try {
      const result = await pool.query(
        'UPDATE profiles SET name = $1, email = $2, role = $3 WHERE id = $4 RETURNING id, name, email, role',
        [name, email, role, id]
      );
      res.json(result.rows[0]);
    } catch (err) {
      res.status(500).json({ error: "Erro ao atualizar usuário" });
    }
  });

  app.delete("/api/users/:id", async (req, res) => {
    if (!hasDbConfig) return res.status(503).json({ error: "DB offline" });
    try {
      await pool.query('DELETE FROM profiles WHERE id = $1', [req.params.id]);
      res.sendStatus(204);
    } catch (err) {
      res.status(500).json({ error: "Erro ao excluir usuário" });
    }
  });

  app.patch("/api/users/:id/password", async (req, res) => {
    if (!hasDbConfig) return res.status(503).json({ error: "DB offline" });
    const { password } = req.body;
    try {
      await pool.query('UPDATE profiles SET password = $1 WHERE id = $2', [password, req.params.id]);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: "Erro ao atualizar senha" });
    }
  });

  // Orders
  app.get("/api/orders", async (req, res) => {
    if (!hasDbConfig) return res.status(503).json({ error: "DB offline" });
    try {
      const result = await pool.query('SELECT * FROM orders ORDER BY created_at DESC');
      res.json(result.rows);
    } catch (err) {
      res.status(500).json({ error: "Erro ao buscar pedidos" });
    }
  });

  app.get("/api/orders/rep/:repId", async (req, res) => {
    if (!hasDbConfig) return res.status(503).json({ error: "DB offline" });
    try {
      const result = await pool.query('SELECT * FROM orders WHERE representative_id = $1 ORDER BY created_at DESC', [req.params.repId]);
      res.json(result.rows);
    } catch (err) {
      res.status(500).json({ error: "Erro ao buscar pedidos do representante" });
    }
  });

  app.post("/api/orders", async (req, res) => {
    if (!hasDbConfig) return res.status(503).json({ error: "DB offline" });
    const { representativeId, items, customerName, customerEmail, customerContact, notes } = req.body;
    try {
      const result = await pool.query(
        'INSERT INTO orders (representative_id, items, customer_name, customer_email, customer_contact, notes, status, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW()) RETURNING *',
        [representativeId, JSON.stringify(items), customerName, customerEmail, customerContact, notes, 'Novo']
      );
      res.json(result.rows[0]);
    } catch (err) {
      console.error("Order creation error:", err);
      res.status(500).json({ error: "Erro ao criar pedido" });
    }
  });

  app.put("/api/orders/:id", async (req, res) => {
    if (!hasDbConfig) return res.status(503).json({ error: "DB offline" });
    const { id } = req.params;
    const { representativeId, items, customerName, customerEmail, customerContact, notes, status } = req.body;
    try {
      const result = await pool.query(
        'UPDATE orders SET representative_id = $1, items = $2, customer_name = $3, customer_email = $4, customer_contact = $5, notes = $6, status = $7 WHERE id = $8 RETURNING *',
        [representativeId, JSON.stringify(items), customerName, customerEmail, customerContact, notes, status, id]
      );
      res.json(result.rows[0]);
    } catch (err) {
      res.status(500).json({ error: "Erro ao atualizar pedido" });
    }
  });

  app.patch("/api/orders/:id/status", async (req, res) => {
    if (!hasDbConfig) return res.status(503).json({ error: "DB offline" });
    const { status } = req.body;
    try {
      await pool.query('UPDATE orders SET status = $1 WHERE id = $2', [status, req.params.id]);
      res.sendStatus(200);
    } catch (err) {
      res.status(500).json({ error: "Erro ao atualizar status do pedido" });
    }
  });

  app.delete("/api/orders/:id", async (req, res) => {
    if (!hasDbConfig) return res.status(503).json({ error: "DB offline" });
    try {
      await pool.query('DELETE FROM orders WHERE id = $1', [req.params.id]);
      res.sendStatus(204);
    } catch (err) {
      res.status(500).json({ error: "Erro ao excluir pedido" });
    }
  });

  // Products extensions
  app.post("/api/products", async (req, res) => {
    if (!hasDbConfig) return res.status(503).json({ error: "DB offline" });
    const { code, description, reference, colors, imageUrl, category, subcategory, line, amperage, details } = req.body;
    try {
      const result = await pool.query(
        'INSERT INTO products (code, description, reference, colors, image_url, category, subcategory, line, amperage, details) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *',
        [code, description, reference, colors, imageUrl, category, subcategory, line, amperage, details]
      );
      res.json(result.rows[0]);
    } catch (err) {
      res.status(500).json({ error: "Erro ao criar produto" });
    }
  });

  app.put("/api/products/:id", async (req, res) => {
    if (!hasDbConfig) return res.status(503).json({ error: "DB offline" });
    const { id } = req.params;
    const { code, description, reference, colors, imageUrl, category, subcategory, line, amperage, details } = req.body;
    try {
      const result = await pool.query(
        'UPDATE products SET code = $1, description = $2, reference = $3, colors = $4, image_url = $5, category = $6, subcategory = $7, line = $8, amperage = $9, details = $10 WHERE id = $11 RETURNING *',
        [code, description, reference, colors, imageUrl, category, subcategory, line, amperage, details, id]
      );
      res.json(result.rows[0]);
    } catch (err) {
      res.status(500).json({ error: "Erro ao atualizar produto" });
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
    console.log(`Conectado ao Azure DB: ${process.env.DB_HOST || 'Aguardando config'}`);
  });
}

startServer();
