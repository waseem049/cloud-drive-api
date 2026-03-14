import {Pool} from 'pg';

const dbUrl = process.env.DATABASE_URL;
console.log('Connecting to:', dbUrl?.replace(/\/\/.*:/, '//***:'));

export const pool = new Pool({
    connectionString: dbUrl,
    ssl: { rejectUnauthorized: false },
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
});

// Generic query helper - always releases connection back to the pool
export async function query<T = any>(
    text: string,
    params?: any[]
): Promise<T[]> {
    const client = await pool.connect();
    try {
        const result = await client.query(text, params);
        return result.rows as T[];
    } finally {
        client.release();
    }
}

// Called once on server startup to verify database connection
export async function testDbConnection(): Promise<void> {
    try {
        const rows = await query<{time: string}>('SELECT NOW() AS time');
        console.log(`Database connected successfully at ${rows[0].time}`);
    } catch (err) {
        console.error('Database connection failed:', err);
        process.exit(1); // Exit the process if database connection fails
    }   
}