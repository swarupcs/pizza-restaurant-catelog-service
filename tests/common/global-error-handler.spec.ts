import { NextFunction, Request, Response } from "express";
import createHttpError, { HttpError } from "http-errors";

import { globalErrorHandler } from "../../src/common/middlewares/globalErrorHandler";

interface ErrorEnvelope {
    errors: {
        ref: string;
        type: string;
        msg: string;
        path: string;
        location: string;
        stack: string | null;
    }[];
}

describe("globalErrorHandler", () => {
    const makeResponse = () => {
        const res = {
            status: jest.fn().mockReturnThis(),
            json: jest.fn().mockReturnThis(),
        };
        return res as unknown as Response & {
            status: jest.Mock;
            json: jest.Mock;
        };
    };

    const req = { path: "/products", method: "POST" } as Request;
    const next = jest.fn() as unknown as NextFunction;

    const bodyOf = (res: { json: jest.Mock }) =>
        res.json.mock.calls[0][0] as ErrorEnvelope;

    it("should use the status carried by the error", () => {
        const res = makeResponse();

        globalErrorHandler(
            createHttpError(404, "Product not found"),
            req,
            res,
            next,
        );

        expect(res.status).toHaveBeenCalledWith(404);
    });

    it("should fall back to 500 for an error with no status", () => {
        const res = makeResponse();

        globalErrorHandler(new Error("boom") as HttpError, req, res, next);

        expect(res.status).toHaveBeenCalledWith(500);
    });

    it("should return the standard envelope", () => {
        const res = makeResponse();

        globalErrorHandler(
            createHttpError(400, "Product name is required"),
            req,
            res,
            next,
        );

        const error = bodyOf(res).errors[0];

        expect(error.msg).toBe("Product name is required");
        expect(error.type).toBe("BadRequestError");
        expect(error.path).toBe("/products");
        expect(error.location).toBe("server");
    });

    it("should attach a unique reference id to every error", () => {
        const first = makeResponse();
        const second = makeResponse();

        globalErrorHandler(createHttpError(400, "Bad"), req, first, next);
        globalErrorHandler(createHttpError(400, "Bad"), req, second, next);

        expect(bodyOf(first).errors[0].ref).toEqual(expect.any(String));
        expect(bodyOf(first).errors[0].ref).not.toBe(
            bodyOf(second).errors[0].ref,
        );
    });

    it("should include the stack outside production", () => {
        const res = makeResponse();

        globalErrorHandler(createHttpError(400, "Bad"), req, res, next);

        expect(bodyOf(res).errors[0].stack).toEqual(expect.any(String));
    });

    describe("in production", () => {
        let previous: string | undefined;

        beforeEach(() => {
            previous = process.env.NODE_ENV;
            process.env.NODE_ENV = "production";
        });

        afterEach(() => {
            process.env.NODE_ENV = previous;
        });

        it("should null the stack", () => {
            const res = makeResponse();

            globalErrorHandler(createHttpError(400, "Bad"), req, res, next);

            expect(bodyOf(res).errors[0].stack).toBeNull();
        });

        it("should replace the message with a generic one", () => {
            const res = makeResponse();

            globalErrorHandler(
                new Error(
                    "E11000 duplicate key error collection: catalog.products",
                ) as HttpError,
                req,
                res,
                next,
            );

            expect(bodyOf(res).errors[0].msg).toBe(
                "An unexpected error occurred.",
            );
        });

        it("should hide 4xx messages too, unlike auth-service", () => {
            // Worth pinning down because the two services differ here.
            // auth-service echoes the message for a 400 and masks everything
            // else; this one masks every status in production. A client here
            // gets "An unexpected error occurred." for a plain validation
            // failure, which is not much to act on.
            const res = makeResponse();

            globalErrorHandler(
                createHttpError(400, "Product name is required"),
                req,
                res,
                next,
            );

            expect(bodyOf(res).errors[0].msg).toBe(
                "An unexpected error occurred.",
            );
        });
    });
});
