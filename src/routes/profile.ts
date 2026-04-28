/**
 * profile.ts — User Profile & Settings Routes
 *
 * ─── LEARNING NOTES ────────────────────────────────────────
 *
 * WHY separate profile routes from auth routes?
 * Auth routes handle authentication (login, register, tokens).
 * Profile routes handle user data management (name, email, password).
 * This is the "Single Responsibility Principle" — each module does one thing.
 *
 * Security considerations for password changes:
 * We ALWAYS require the current password before allowing a change.
 * This prevents an attacker who steals a session from locking the real user out.
 *
 * WHY do we return minimal data in responses?
 * Principle of Least Privilege — never send more data than the client needs.
 * e.g., we never include password_hash in responses.
 */

import { Router, Request, Response, NextFunction } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { query } from "../db/client";
import { requireAuth } from "../middleware/auth";
import { AppError } from "../middleware/errorHandler";

export const profileRouter = Router();

// All profile routes require an authenticated user
profileRouter.use(requireAuth);

// ── Schemas ──────────────────────────────────────────────────
// Zod schemas define the SHAPE of valid request bodies.
// .min()/.max() add length constraints.
// .optional() means the field can be omitted entirely.

const UpdateProfileSchema = z.object({
    name: z.string().min(1, "Name cannot be empty").max(100).optional(),
    email: z.string().email("Invalid email").optional(),
});

const ChangePasswordSchema = z.object({
    // We require the current password to prevent session-hijack abuse
    currentPassword: z.string().min(1, "Current password is required"),
    newPassword: z.string().min(8, "New password must be at least 8 characters"),
});

// ── GET /api/profile ─────────────────────────────────────────
// Return the authenticated user's profile data.
// This is used by the settings page to pre-fill the form.
profileRouter.get("/", async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { userId } = req.user!;

        const users = await query<{
            id: string;
            email: string;
            name: string;
            image_url: string | null;
            created_at: string;
        }>(
            `SELECT id, email, name, image_url, created_at
             FROM users WHERE id = $1`,
            [userId]
        );

        if (users.length === 0) {
            throw new AppError("NOT_FOUND", "User not found", 404);
        }

        const u = users[0];
        res.json({
            user: {
                id: u.id,
                email: u.email,
                name: u.name,
                imageUrl: u.image_url,
                createdAt: u.created_at,
            },
        });
    } catch (err) {
        next(err);
    }
});

// ── PATCH /api/profile ───────────────────────────────────────
// Update user's name and/or email.
//
// COALESCE($1, name) — SQL trick: if $1 is NULL, keep the existing value.
// This lets the client send ONLY the fields they want to change.
profileRouter.patch("/", async (req: Request, res: Response, next: NextFunction) => {
    try {
        const body = UpdateProfileSchema.safeParse(req.body);
        if (!body.success) {
            throw new AppError("VALIDATION_ERROR", body.error.issues[0].message, 400);
        }

        const { userId } = req.user!;
        const { name, email } = body.data;

        // If changing email, check it's not already taken by another user
        if (email) {
            const existing = await query(
                `SELECT id FROM users WHERE email = $1 AND id != $2`,
                [email.toLowerCase(), userId]
            );
            if (existing.length > 0) {
                throw new AppError("CONFLICT", "Email is already in use", 409);
            }
        }

        const updated = await query<{
            id: string;
            email: string;
            name: string;
            image_url: string | null;
        }>(
            `UPDATE users
             SET name = COALESCE($1, name),
                 email = COALESCE($2, email)
             WHERE id = $3
             RETURNING id, email, name, image_url`,
            [name ?? null, email?.toLowerCase() ?? null, userId]
        );

        if (updated.length === 0) {
            throw new AppError("NOT_FOUND", "User not found", 404);
        }

        const u = updated[0];
        res.json({
            user: {
                id: u.id,
                email: u.email,
                name: u.name,
                imageUrl: u.image_url,
            },
        });
    } catch (err) {
        next(err);
    }
});

// ── POST /api/profile/password ───────────────────────────────
// Change password. Requires the CURRENT password for verification.
//
// Security flow:
//   1. Verify current password matches the stored hash
//   2. Hash the new password with bcrypt (cost 12)
//   3. Update the hash in user_credentials table
//
// WHY bcrypt with cost 12?
// bcrypt is designed to be SLOW — that's a feature, not a bug.
// Cost 12 means 2^12 = 4096 iterations of the internal hash.
// This makes brute-force attacks infeasible while staying fast
// enough for individual login attempts (~250ms on modern hardware).
profileRouter.post("/password", async (req: Request, res: Response, next: NextFunction) => {
    try {
        const body = ChangePasswordSchema.safeParse(req.body);
        if (!body.success) {
            throw new AppError("VALIDATION_ERROR", body.error.issues[0].message, 400);
        }

        const { userId } = req.user!;
        const { currentPassword, newPassword } = body.data;

        // Step 1: Fetch current password hash
        const creds = await query<{ password_hash: string }>(
            `SELECT password_hash FROM user_credentials WHERE user_id = $1`,
            [userId]
        );
        if (creds.length === 0) {
            throw new AppError("NOT_FOUND", "User credentials not found", 404);
        }

        // Step 2: Verify current password
        const isValid = await bcrypt.compare(currentPassword, creds[0].password_hash);
        if (!isValid) {
            throw new AppError("INVALID_CREDENTIALS", "Current password is incorrect", 401);
        }

        // Step 3: Hash new password and update
        const newHash = await bcrypt.hash(newPassword, 12);
        await query(
            `UPDATE user_credentials SET password_hash = $1 WHERE user_id = $2`,
            [newHash, userId]
        );

        res.json({ message: "Password updated successfully" });
    } catch (err) {
        next(err);
    }
});
