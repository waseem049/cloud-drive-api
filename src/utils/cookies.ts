import { Response } from "express";

// All cookie settings in one place - never scatter these around the codebase
const IS_PROD = process.env.NODE_ENV === "production";

export function setAuthCookies(
    res: Response,
    accessToken: string,
    refreshToken: string
): void {
    // Access token - short lived, httpOnly for security
    res.cookie("accessToken", accessToken, {
        httpOnly: true,
        secure: IS_PROD,
        sameSite: IS_PROD ? "none" : "lax",
        maxAge: 15 * 60 * 1000, // 15 minutes
    });

    // Refresh token - longer lived, httpOnly for security
    res.cookie('refreshToken', refreshToken, {
        httpOnly: true,
        secure: IS_PROD,
        sameSite: IS_PROD ? 'none' : 'lax',
        maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
        path: '/api/auth/refresh' // Only send refresh token to this endpoint
    });

    // Non-httpOnly flag - frontend reads this to know user is logged in
    // Contains NO sensitive data - just a boolean signal
    res.cookie('is_authenticated', 'true', {
        httpOnly: false,
        secure: IS_PROD,
        sameSite: IS_PROD ? 'none' : 'lax',
        maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    });
}

export function clearAuthCookies(res: Response): void {
    const sameSiteVal = IS_PROD ? 'none' as const : 'lax' as const;
    const opts = {
        httpOnly: true,
        secure: IS_PROD,
        sameSite: sameSiteVal,
    };
    res.clearCookie('accessToken', opts);
    res.clearCookie('refreshToken', { ...opts, path: '/api/auth/refresh' });
    res.clearCookie('is_authenticated', { httpOnly: false, secure: IS_PROD, sameSite: sameSiteVal });
}

// Why is_authenticated? The httpOnly cookies are invisible to JavaScript, that's the point. But the frontend needs to know whether the user is logge in without making an API cal on every render. This non-httpOnly cookie contains zero sensitive data - it's just a flag. The real auth check is always server-side.

// Why path: '/auth/refresh' on the refresh token? The browser only sends this cookie to that one endpoint. Even if an attacker somehow triggers a request to a different endpoint, the refresh token is never included. Hence minimal exposure.