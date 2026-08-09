import request from "supertest";
import mongoose from "mongoose";

jest.mock("../../src/common/services/S3Storage", () => require("../mocks/s3"));
jest.mock("../../src/common/factories/brokerFactory", () =>
    require("../mocks/broker"),
);

import app from "../../src/app";
import CategoryModel from "../../src/category/category-model";
import { Category } from "../../src/category/category-types";
import { clearDb, connectDb, disconnectDb } from "../utils/db";
import { categoryPayload } from "../utils/fixtures";

describe("Reading categories", () => {
    beforeAll(async () => {
        await connectDb();
    });

    beforeEach(async () => {
        await clearDb();
    });

    afterAll(async () => {
        await disconnectDb();
    });

    describe("GET /categories", () => {
        it("should return the 200 status code", async () => {
            const response = await request(app).get("/categories").send();

            expect(response.statusCode).toBe(200);
        });

        it("should return an empty array when there are no categories", async () => {
            const response = await request(app).get("/categories").send();

            expect(response.body as Category[]).toEqual([]);
        });

        it("should return every category", async () => {
            await CategoryModel.create(categoryPayload());
            await CategoryModel.create(categoryPayload({ name: "Beverages" }));

            const response = await request(app).get("/categories").send();
            const body = response.body as Category[];

            expect(body).toHaveLength(2);
            expect(body.map((category) => category.name).sort()).toEqual([
                "Beverages",
                "Pizza",
            ]);
        });

        it("should serialise priceConfiguration as an object", async () => {
            // Stored as a Map; the client UI reads it as plain JSON.
            await CategoryModel.create(categoryPayload());

            const response = await request(app).get("/categories").send();
            const body = response.body as Category[];

            expect(body[0].priceConfiguration.Size.priceType).toBe("base");
            expect(body[0].priceConfiguration.Size.availableOptions).toEqual([
                "Small",
                "Medium",
                "Large",
            ]);
        });

        it("should be readable without authentication", async () => {
            // Deliberate: the customer-facing menu needs the category list
            // before anyone has logged in.
            await CategoryModel.create(categoryPayload());

            const response = await request(app).get("/categories").send();

            expect(response.statusCode).toBe(200);
            expect(response.body as Category[]).toHaveLength(1);
        });
    });

    describe("GET /categories/:categoryId", () => {
        it("should return the category", async () => {
            const category = await CategoryModel.create(categoryPayload());

            const response = await request(app)
                .get(`/categories/${category._id.toString()}`)
                .send();

            expect(response.statusCode).toBe(200);
            expect((response.body as Category).name).toBe("Pizza");
        });

        it("should include the attributes", async () => {
            const category = await CategoryModel.create(categoryPayload());

            const response = await request(app)
                .get(`/categories/${category._id.toString()}`)
                .send();

            expect((response.body as Category).attributes).toHaveLength(2);
        });

        it("should return 404 for a well-formed id that does not exist", async () => {
            const missingId = new mongoose.Types.ObjectId().toString();

            const response = await request(app)
                .get(`/categories/${missingId}`)
                .send();

            expect(response.statusCode).toBe(404);
        });

        it("should return 500 for a malformed id", async () => {
            // BUG, captured rather than asserted as correct. Unlike the PATCH
            // route, this one has no validator, so "not-an-id" reaches
            // Mongoose, throws a CastError, and asyncWrapper turns every
            // rejection into a 500. It should be a 400 — adding
            // `param("categoryId").isMongoId()` to the route would do it, and
            // this expectation then becomes 400.
            const response = await request(app)
                .get("/categories/not-an-id")
                .send();

            expect(response.statusCode).toBe(500);
        });

        it("should be readable without authentication", async () => {
            const category = await CategoryModel.create(categoryPayload());

            const response = await request(app)
                .get(`/categories/${category._id.toString()}`)
                .send();

            expect(response.statusCode).toBe(200);
        });
    });
});
