import { Request, Response, NextFunction } from "express";
import { AppError } from "./errorHandler";
import { verifyAccessToken, TokenPaload } from "../utils/tokens";

// Extend Express Request to carry the authenticated user's info after token verification
declare global {
    namespace Express {
        interface Request {
            user?: TokenPaload; // This will hold the decoded token payload after verification
        }
    }
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
    try {
        const token = req.cookies?.accessToken;
        if(!token) throw new AppError('UNAUTHORIZED', 'No access token provided', 401);

        req.user = verifyAccessToken(token); // If token is valid, attach payload to req.user
        next();
    } catch (err) {
        next(new AppError('UNAUTHORIZED', 'Invalid or expired access token', 401)); 
    }
}
