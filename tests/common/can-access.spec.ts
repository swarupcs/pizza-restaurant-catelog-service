import { NextFunction, Request, Response } from "express";
import { HttpError } from "http-errors";

import { canAccess } from "../../src/common/middlewares/canAccess";
import { AuthRequest } from "../../src/common/types";
import { Roles } from "../../src/common/constants";

describe("canAccess", () => {
    const makeRequest = (role: string) =>
        ({ auth: { role } }) as unknown as AuthRequest as Request;

    const res = {} as Response;

    const errorPassedTo = (next: jest.Mock) =>
        next.mock.calls[0][0] as HttpError;

    it("should call next with no arguments when the role is allowed", () => {
        const next = jest.fn();

        canAccess([Roles.ADMIN])(
            makeRequest(Roles.ADMIN),
            res,
            next as unknown as NextFunction,
        );

        expect(next).toHaveBeenCalledWith();
    });

    it("should allow any role in the list", () => {
        // Products and toppings are writable by both, which is what makes a
        // manager able to run their own menu.
        const next = jest.fn();

        canAccess([Roles.ADMIN, Roles.MANAGER])(
            makeRequest(Roles.MANAGER),
            res,
            next as unknown as NextFunction,
        );

        expect(next).toHaveBeenCalledWith();
    });

    it("should call next with a 403 when the role is not allowed", () => {
        const next = jest.fn();

        canAccess([Roles.ADMIN])(
            makeRequest(Roles.MANAGER),
            res,
            next as unknown as NextFunction,
        );

        expect(errorPassedTo(next).status).toBe(403);
        expect(errorPassedTo(next).message).toBe(
            "You don't have enough permissions",
        );
    });

    it("should reject a customer from a manager-or-admin route", () => {
        const next = jest.fn();

        canAccess([Roles.ADMIN, Roles.MANAGER])(
            makeRequest(Roles.CUSTOMER),
            res,
            next as unknown as NextFunction,
        );

        expect(errorPassedTo(next).status).toBe(403);
    });

    it("should match the role exactly, not by case", () => {
        // The role comes straight off the JWT; a loose compare would be an
        // escalation path.
        const next = jest.fn();

        canAccess([Roles.ADMIN])(
            makeRequest("ADMIN"),
            res,
            next as unknown as NextFunction,
        );

        expect(errorPassedTo(next).status).toBe(403);
    });

    it("should reject an unknown role", () => {
        const next = jest.fn();

        canAccess([Roles.ADMIN])(
            makeRequest("superuser"),
            res,
            next as unknown as NextFunction,
        );

        expect(errorPassedTo(next).status).toBe(403);
    });

    it("should reject everything when the allowed list is empty", () => {
        const next = jest.fn();

        canAccess([])(
            makeRequest(Roles.ADMIN),
            res,
            next as unknown as NextFunction,
        );

        expect(errorPassedTo(next).status).toBe(403);
    });
});
