import sql from 'mssql';

const config = {
  user: process.env.MSSQL_USER,
  password: process.env.MSSQL_PASSWORD,
  database: process.env.MSSQL_DATABASE,
  server: process.env.MSSQL_SERVER || '',
  pool: {
    max: 10,
    min: 0,
    idleTimeoutMillis: 30000
  },
  options: {
    encrypt: true, // For Azure
    trustServerCertificate: false // For Azure
  }
};

export const query = async (text: string, params?: any[]) => {
  if (!config.server) {
    throw new Error('Configuração de servidor MSSQL_SERVER ausente nos Secrets!');
  }
  
  try {
    const pool = await sql.connect(config);
    const request = pool.request();
    
    if (params) {
      params.forEach((val, idx) => {
        request.input(`param${idx}`, val);
      });
    }

    return await request.query(text);
  } catch (err) {
    console.error('Erro de conexão SQL no servidor:', config.server);
    throw err;
  }
};

export default sql;
