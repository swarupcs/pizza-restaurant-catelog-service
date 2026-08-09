import { NextFunction, Request, RequestHandler, Response } from "express";
import createHttpError, { HttpError } from "http-errors";

import { asyncWrapper } from "../../src/common/utils/wrapper";

describe("asyncWrapper", () => {
    const req = {} as Request;
    const res = {} as Response;

    const errorPassedTo = (next: jest.Mock) =>
        next.mock.calls[0][0] as HttpError;

    it("should not call next when the handler resolves", async () => {
        const next = jest.fn();
        const handler = jest.fn().mockResolvedValue(undefined);

        await asyncWrapper(handler as RequestHandler)(
            req,
            res,
            next as unknown as NextFunction,
        );

        expect(handler).toHaveBeenCalledWith(req, res, next);
        expect(next).not.toHaveBeenCalled();
    });

    it("should forward a rejection to next", async () => {
        const next = jest.fn();
        const handler = jest.fn().mockRejectedValue(new Error("boom"));

        await asyncWrapper(handler as RequestHandler)(
            req,
            res,
            next as unknown as NextFunction,
        );

        expect(next).toHaveBeenCalledTimes(1);
        expect(errorPassedTo(next).status).toBe(500);
    });

    it("should keep the original message", async () => {
        const next = jest.fn();
        const handler = jest.fn().mockRejectedValue(new Error("boom"));

        await asyncWrapper(handler as RequestHandler)(
            req,
            res,
            next as unknown as NextFunction,
        );

        expect(errorPassedTo(next).message).toBe("boom");
    });

    it("does not catch a synchronous throw", () => {
        // `Promise.resolve(requestHandler(...))` evaluates the call first, so
        // a handler that throws before its first await escapes the .catch()
        // entirely and propagates out of the middleware.
        //
        // Benign as things stand — Express 5 catches synchronous throws from
        // middleware and routes them to the error handler, so the client
        // still gets a 500 rather than a dropped request. But it means the
        // wrapper's own error shaping is bypassed on that path. Wrapping the
        // call in `Promise.resolve().then(() => requestHandler(...))` would
        // make both paths behave the same.
        const next = jest.fn();
        const handler = jest.fn(() => {
            throw new Error("sync boom");
        });

        expect(() =>
            asyncWrapper(handler as unknown as RequestHandler)(
                req,
                res,
                next as unknown as NextFunction,
            ),
        ).toThrow("sync boom");

        expect(next).not.toHaveBeenCalled();
    });

    it("should use a generic message for a non-Error rejection", async () => {
        const next = jest.fn();
        const handler = jest.fn().mockRejectedValue("just a string");

        await asyncWrapper(handler as RequestHandler)(
            req,
            res,
            next as unknown as NextFunction,
        );

        expect(errorPassedTo(next).message).toBe("Internal server error");
        expect(errorPassedTo(next).status).toBe(500);
    });

    it("flattens a 404 from the handler into a 500 (bug)", async () => {
        // BUG, captured rather than asserted as correct.
        //
        // The wrapper rewrites every rejection as `createHttpError(500, ...)`,
        // including one that already carries a status. A controller that
        // rejects with a 404 or a 403 — rather than calling next() with it —
        // would have that status silently replaced by 500, and the message
        // handed to the client as if it were an internal failure.
        //
        // The controllers here happen to call next() directly for their 4xx
        // paths, so nothing hits this today. Re-throwing when
        // `createHttpError.isHttpError(err)` would make the wrapper safe for
        // the case where one does.
        const next = jest.fn();
        const handler = jest
            .fn()
            .mockRejectedValue(createHttpError(404, "Product not found"));

        await asyncWrapper(handler as RequestHandler)(
            req,
            res,
            next as unknown as NextFunction,
        );

        expect(errorPassedTo(next).status).toBe(500);
    });
});
