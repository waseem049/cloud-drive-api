import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import morgan from 'morgan';
import { testDbConnection } from './db/client';
import { errorHandler } from './middleware/errorHandler';

const app = express();
const PORT = process.env.PORT || 5000;

// -- Security & Logging Middleware --
app.use(helmet());
app.use(morgan('dev'));

// -- CORS - Must come before routes --
app.use(cors({
    origin: process.env.CLIENT_URL || process.env.FRONTEND_URL || 'http://localhost:3000',
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

// -- Body Parsing Middleware --
app.use(express.json({ limit: '1mb' })); // limit prevents large payloads attacks
app.use(cookieParser());

// -- Routes --
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        timeStamp: new Date().toISOString(),
        environment: process.env.NODE_ENV,
    });
});

// DAY 2 uncomment when ready to build each router


// -- Error Handling Middleware --
app.use(errorHandler);

// -- Start Server --
app.listen(PORT, async () => {
    console.log(`Server running on port ${PORT} in ${process.env.NODE_ENV} mode`);
    await testDbConnection();
});