import { Router, Request, Response, NextFunction } from "express";
import { createHash, randomBytes } from "node:crypto";
import bcrypt from 'bcryptjs';
import { z } from "zod";
import { query } from "../db/client";
import { AppError } from "../middleware/errorHandler";
import { clearAuthCookies, setAuthCookies } from "../utils/cookies";
import { signAccessToken, signRefreshToken, verifyAccessToken, verifyRefreshToken } from "../utils/tokens";

const RESET_TOKEN_BYTES = 32;
const RESET_EXPIRY_MS = 60 * 60 * 1000; // 1 hour

function hashResetToken(raw: string): string {
    return createHash("sha256").update(raw, "utf8").digest("hex");
}

function forgotPasswordResponsePayload(resetUrl: string | null) {
    const base = {
        message:
            "If an account exists for that email, we sent a link to reset your password.",
    };
    if (process.env.NODE_ENV !== "production" && resetUrl) {
        return { ...base, _devResetUrl: resetUrl };
    }
    return base;
}


export const authRouter = Router();

// Zod schemas - validate request bodies at runtime
const RegisterSchema = z.object({
    email: z.string().email('Invalid email address'),
    password: z.string().min(8, 'Password must be at least 8 characters long'),
    name: z.string().min(1, 'Name is required').max(100, 'Name must be less than 100 characters'),
});

const LoginSchema = z.object({
    email: z.string().email(),
    password: z.string().min(1),
});

const ForgotPasswordSchema = z.object({
    email: z.string().email(),
});

const ResetPasswordSchema = z.object({
    token: z.string().min(1, "Reset token is required"),
    password: z.string().min(8, "Password must be at least 8 characters long"),
});

// POST /auth/register
authRouter.post('/register', async (req: Request, res: Response, next: NextFunction) => {
    try {
        // 1. Validate input
        const body = RegisterSchema.safeParse(req.body);
        if (!body.success) {
            throw new AppError('VALIDATION_ERROR', body.error.issues[0].message, 400);
        }
        const { email, password, name } = body.data;

        // 2. Check if user already exists
        const existingUser = await query(
            'SELECT * FROM users WHERE email = $1',
            [email.toLowerCase()]
        );
        if (existingUser.length > 0) {
            throw new AppError('CONFLICT', 'Email is already registered', 409);
        }

        // 3. Hash password - cost of 12 is a good balance between security and performance
        const passwordHash = await bcrypt.hash(password, 12);

        // 4. Insert new user into database
        const users = await query<{ id: string; email: string; name: string }>(
            `INSERT INTO users (email, name, image_url)
            VALUES ($1, $2, null)
            RETURNING id, email, name`,
            [email.toLowerCase(), name]
        );

        // 5. Store password hash in separate table (not in users - separation of concerns)
        await query(
            `INSERT INTO user_credentials (user_id, password_hash) VALUES ($1, $2)`,
            [users[0].id, passwordHash]
        );

        // 6. Sign tokens and set cookies
        const user = users[0];
        const payload = { userId: user.id, email: user.email };
        setAuthCookies(res, signAccessToken(payload), signRefreshToken(payload));
        
        res.status(201).json({
            user: { id: user.id, email: user.email, name: user.name, imageUrl: null }
        });
    } catch (err) {
        next(err);
    }
});

// POST /auth/login
authRouter.post('/login', async (req: Request, res: Response, next: NextFunction) => {
    try {
        // 1. Validate input
        const body = LoginSchema.safeParse(req.body);
        if (!body.success) {
            throw new AppError('VALIDATION_ERROR', body.error.issues[0].message, 400);
        }
        const { email, password } = body.data;

        // 2. Find use + password hash in one join
        const rows = await query<{
            id: string; email: string;name: string;
            image_url: string | null;
            password_hash: string;
        }>(
            `SELECT u.id, u.email, u.name, u.image_url, uc.password_hash
            FROM users u
            JOIN user_credentials uc ON u.id = uc.user_id
            WHERE u.email = $1`,
            [email.toLowerCase()]
        );

        // 3. Same error for "not found" and "wrong password" - don't give attackers clues
        const INVALID = new AppError('INVALID_CREDENTIALS', 'Invalid email or password', 401);
        if (rows.length === 0) throw INVALID;

        const user = rows[0];
        const valid = await bcrypt.compare(password, user.password_hash);
        if (!valid) throw INVALID;

        // 4. Set cookies and return user (without password hash)
        const payload = { userId: user.id, email: user.email };
        setAuthCookies(res, signAccessToken(payload), signRefreshToken(payload));
        
        res.json({
            user: {
                id: user.id,
                email: user.email,
                name: user.name,
                imageUrl: user.image_url,
            }
        });
    } catch (err) {
        next(err);
    }
});

// POST /auth/logout
authRouter.post('/logout', (req: Request, res: Response) => {
    clearAuthCookies(res);
    res.json({ message: 'Logged out successfully' });
});

// GET /auth/me - returns current user info based on access token
authRouter.get('/me', async(req: Request, res: Response, next: NextFunction) => {
    try {
        const token = req.cookies?.accessToken;
        if(!token) throw new AppError('UNAUTHORIZED', 'No access token provided', 401);

        const payload = verifyAccessToken(token);

        const users = await query<{ id: string; email: string; name: string; image_url: string | null }>(
            'SELECT id, email, name, image_url FROM users WHERE id = $1',
            [payload.userId]
        );
        if(users.length ===0) throw new AppError('NOT_FOUND', 'User not found', 404);

        const user = users[0];
        res.json({
            user: { id: user.id, email: user.email, name: user.name, imageUrl: user.image_url}
        });
    } catch (err) {
        next(err);
    }
});

// POST /auth/forgot-password
authRouter.post("/forgot-password", async (req: Request, res: Response, next: NextFunction) => {
    try {
        const parsed = ForgotPasswordSchema.safeParse(req.body);
        if (!parsed.success) {
            throw new AppError("VALIDATION_ERROR", parsed.error.issues[0].message, 400);
        }
        const email = parsed.data.email.toLowerCase();

        const users = await query<{ id: string }>(
            `SELECT u.id FROM users u
             INNER JOIN user_credentials uc ON uc.user_id = u.id
             WHERE u.email = $1`,
            [email]
        );

        let devUrl: string | null = null;
        if (users.length > 0) {
            const raw = randomBytes(RESET_TOKEN_BYTES).toString("hex");
            const tokenHash = hashResetToken(raw);
            const expiresAt = new Date(Date.now() + RESET_EXPIRY_MS);

            await query(`DELETE FROM password_reset_tokens WHERE user_id = $1 AND used_at IS NULL`, [
                users[0].id,
            ]);

            await query(
                `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
                 VALUES ($1, $2, $3)`,
                [users[0].id, tokenHash, expiresAt.toISOString()]
            );

            const webOrigin = (process.env.WEB_ORIGIN || process.env.CORS_ORIGIN || "http://localhost:3000").replace(
                /\/$/,
                ""
            );
            const resetUrl = `${webOrigin}/reset-password?token=${raw}`;
            devUrl = resetUrl;

            if (process.env.NODE_ENV !== "production") {
                console.info("[auth] password reset link (dev):", resetUrl);
            }
        }

        res.json(forgotPasswordResponsePayload(devUrl));
    } catch (err) {
        next(err);
    }
});

// POST /auth/reset-password
authRouter.post("/reset-password", async (req: Request, res: Response, next: NextFunction) => {
    try {
        const parsed = ResetPasswordSchema.safeParse(req.body);
        if (!parsed.success) {
            throw new AppError("VALIDATION_ERROR", parsed.error.issues[0].message, 400);
        }
        const { token: rawToken, password } = parsed.data;
        const tokenHash = hashResetToken(rawToken.trim());

        const rows = await query<{ id: string; user_id: string }>(
            `SELECT id, user_id FROM password_reset_tokens
             WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()`,
            [tokenHash]
        );

        if (rows.length === 0) {
            throw new AppError(
                "INVALID_TOKEN",
                "This reset link is invalid or has expired. Request a new one.",
                400
            );
        }

        const { id: tokenRowId, user_id: userId } = rows[0];
        const passwordHash = await bcrypt.hash(password, 12);

        await query(`UPDATE user_credentials SET password_hash = $1 WHERE user_id = $2`, [
            passwordHash,
            userId,
        ]);

        await query(`UPDATE password_reset_tokens SET used_at = now() WHERE id = $1`, [tokenRowId]);
        await query(`DELETE FROM password_reset_tokens WHERE user_id = $1 AND used_at IS NULL`, [userId]);

        res.json({ message: "Your password has been updated. You can sign in." });
    } catch (err) {
        next(err);
    }
});

// POST /auth/refresh - issues new access token if refresh token is valid
authRouter.post('/refresh', async(req: Request, res: Response, next: NextFunction) => {
    try {
        const token = req.cookies?.refreshToken;
        if(!token) throw new AppError('UNAUTHORIZED', 'No refresh token provided', 401);

        const payload = verifyRefreshToken(token);
        const newPayload = { userId: payload.userId, email: payload.email };
        setAuthCookies(res, signAccessToken(newPayload), signRefreshToken(newPayload));

        res.json({ message: 'Token refreshed' });
    } catch (err) {
        next(err);
    }
});


