import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';

dotenv.config();
import { env } from "./env";

const JWT_SECRET = env().JWT_SECRET;
const REFRESH_TOKEN_SECRET = env().JWT_REFRESH_SECRET;

export type TokenPaload = {
    userId: string;
    email: string;
};

export function signAccessToken(payload: TokenPaload): string {
    return jwt.sign(payload, JWT_SECRET, { expiresIn: '15m' });
}

export function signRefreshToken(payload: TokenPaload): string {
    return jwt.sign(payload, REFRESH_TOKEN_SECRET, { expiresIn: '7d' });
}

export function verifyAccessToken(token: string): TokenPaload {
    return jwt.verify(token, JWT_SECRET) as TokenPaload;
}

export function verifyRefreshToken(token: string): TokenPaload {
    return jwt.verify(token, REFRESH_TOKEN_SECRET) as TokenPaload;
}

