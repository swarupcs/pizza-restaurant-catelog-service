import request from "supertest";
import mongoose from "mongoose";
import createJWKSMock from "mock-jwks";

jest.mock("../../src/common/services/S3Storage", () => require("../mocks/s3"));
jest.mock("../../src/common/factories/brokerFactory", () =>
    require("../mocks/broker"),
);

import app from "../../src/app";
import CategoryModel from "../../src/category/category-model";
import { Roles } from "../../src/common/constants";
import { clearDb, connectDb, disconnectDb } from "../utils/db";
import { categoryPayload } from "../utils/fixtures";

describe("PATCH /categories/:id", () => {
    let jwks: ReturnType<typeof createJWKSMock>;
    let adminToken: string;

    beforeAll(async () => {
        jwks = createJWKSMock("http://localhost:5501");
        await connectDb();
    });

    beforeEach(async () => {
        jwks.start();
        await clearDb();
        adminToken = jwks.token({ sub: "1", role: Roles.ADMIN });
    });

    afterEach(() => {
        jwks.stop();
    });

    afterAll(async () => {
        await disconnectDb();
    });

    const seedCategory = async () =>
        await CategoryModel.create(categoryPayload());

    describe("Given a valid update", () => {
        it("should return the 200 status code and the id", async () => {
            const category = await seedCategory();

            const response = await request(app)
                .patch(`/categories/${category._id.toString()}`)
                .set("Cookie", [`accessToken=${adminToken}`])
                .send({ name: "Pizzas" });

            expect(response.statusCode).toBe(200);
            expect((response.body as { id: string }).id).toBe(
                category._id.toString(),
            );
        });

        it("should update the name", async () => {
            const category = await seedCategory();

            await request(app)
                .patch(`/categories/${category._id.toString()}`)
                .set("Cookie", [`accessToken=${adminToken}`])
                .send({ name: "Pizzas" });

            const updated = await CategoryModel.findById(category._id);
            expect(updated!.name).toBe("Pizzas");
        });

        it("should merge priceConfiguration rather than replace it", async () => {
            // This is the whole reason the controller reads the category
            // before writing. A PATCH that sends only Size must not silently
            // drop Crust — that would wipe pricing for every product in the
            // category.
            const category = await seedCategory();

            await request(app)
                .patch(`/categories/${category._id.toString()}`)
                .set("Cookie", [`accessToken=${adminToken}`])
                .send({
                    priceConfiguration: {
                        Size: {
                            priceType: "base",
                            availableOptions: ["Small", "Large"],
                        },
                    },
                });

            const updated = await CategoryModel.findById(category._id);
            const config = updated!.priceConfiguration as unknown as Map<
                string,
                { priceType: string; availableOptions: string[] }
            >;

            expect(config.get("Size")?.availableOptions).toEqual([
                "Small",
                "Large",
            ]);
            // Untouched key survives.
            expect(config.get("Crust")?.priceType).toBe("aditional");
        });

        it("should add a new priceConfiguration key alongside the existing ones", async () => {
            const category = await seedCategory();

            await request(app)
                .patch(`/categories/${category._id.toString()}`)
                .set("Cookie", [`accessToken=${adminToken}`])
                .send({
                    priceConfiguration: {
                        Toppings: {
                            priceType: "aditional",
                            availableOptions: ["Cheese"],
                        },
                    },
                });

            const updated = await CategoryModel.findById(category._id);
            const config = updated!.priceConfiguration as unknown as Map<
                string,
                { priceType: string }
            >;

            expect(config.get("Toppings")?.priceType).toBe("aditional");
            expect(config.get("Size")?.priceType).toBe("base");
            expect(config.get("Crust")?.priceType).toBe("aditional");
        });

        it("should replace the attributes array wholesale", async () => {
            // attributes get no merge treatment — worth pinning down, because
            // it is the opposite of how priceConfiguration behaves.
            const category = await seedCategory();

            await request(app)
                .patch(`/categories/${category._id.toString()}`)
                .set("Cookie", [`accessToken=${adminToken}`])
                .send({
                    attributes: [
                        {
                            name: "isVegan",
                            widgetType: "switch",
                            defaultValue: "No",
                            availableOptions: ["Yes", "No"],
                        },
                    ],
                });

            const updated = await CategoryModel.findById(category._id);

            expect(updated!.attributes).toHaveLength(1);
            expect(updated!.attributes[0].name).toBe("isVegan");
        });
    });

    describe("Given an invalid request", () => {
        it("should return 400 if the id is not a Mongo id", async () => {
            const response = await request(app)
                .patch("/categories/not-an-id")
                .set("Cookie", [`accessToken=${adminToken}`])
                .send({ name: "Pizzas" });

            expect(response.statusCode).toBe(400);
        });

        it("should return 404 if the category does not exist", async () => {
            const missingId = new mongoose.Types.ObjectId().toString();

            const response = await request(app)
                .patch(`/categories/${missingId}`)
                .set("Cookie", [`accessToken=${adminToken}`])
                .send({ name: "Pizzas" });

            expect(response.statusCode).toBe(404);
        });

        it("should return 400 for an empty body", async () => {
            const category = await seedCategory();

            const response = await request(app)
                .patch(`/categories/${category._id.toString()}`)
                .set("Cookie", [`accessToken=${adminToken}`])
                .send({});

            expect(response.statusCode).toBe(400);
        });

        it("should return 400 for an empty name", async () => {
            const category = await seedCategory();

            const response = await request(app)
                .patch(`/categories/${category._id.toString()}`)
                .set("Cookie", [`accessToken=${adminToken}`])
                .send({ name: "   " });

            expect(response.statusCode).toBe(400);
        });

        it("should return 400 for an unknown priceType", async () => {
            const category = await seedCategory();

            const response = await request(app)
                .patch(`/categories/${category._id.toString()}`)
                .set("Cookie", [`accessToken=${adminToken}`])
                .send({
                    priceConfiguration: {
                        Size: {
                            priceType: "premium",
                            availableOptions: ["Small"],
                        },
                    },
                });

            expect(response.statusCode).toBe(400);
        });

        it("should return 400 if availableOptions is not an array", async () => {
            const category = await seedCategory();

            const response = await request(app)
                .patch(`/categories/${category._id.toString()}`)
                .set("Cookie", [`accessToken=${adminToken}`])
                .send({
                    priceConfiguration: {
                        Size: {
                            priceType: "base",
                            availableOptions: "Small",
                        },
                    },
                });

            expect(response.statusCode).toBe(400);
        });

        it("should return 400 for an unknown widgetType", async () => {
            const category = await seedCategory();

            const response = await request(app)
                .patch(`/categories/${category._id.toString()}`)
                .set("Cookie", [`accessToken=${adminToken}`])
                .send({
                    attributes: [
                        {
                            name: "isVegan",
                            widgetType: "dropdown",
                            defaultValue: "No",
                            availableOptions: ["Yes"],
                        },
                    ],
                });

            expect(response.statusCode).toBe(400);
        });

        it("should leave the category untouched when validation fails", async () => {
            const category = await seedCategory();

            await request(app)
                .patch(`/categories/${category._id.toString()}`)
                .set("Cookie", [`accessToken=${adminToken}`])
                .send({ name: "" });

            const untouched = await CategoryModel.findById(category._id);
            expect(untouched!.name).toBe("Pizza");
        });
    });

    describe("Access control", () => {
        it("should return 401 if the caller is not authenticated", async () => {
            const category = await seedCategory();

            const response = await request(app)
                .patch(`/categories/${category._id.toString()}`)
                .send({ name: "Pizzas" });

            expect(response.statusCode).toBe(401);
        });

        it("should return 403 if the caller is a manager", async () => {
            const category = await seedCategory();
            const managerToken = jwks.token({
                sub: "1",
                role: Roles.MANAGER,
                tenant: "1",
            });

            const response = await request(app)
                .patch(`/categories/${category._id.toString()}`)
                .set("Cookie", [`accessToken=${managerToken}`])
                .send({ name: "Pizzas" });

            expect(response.statusCode).toBe(403);

            const untouched = await CategoryModel.findById(category._id);
            expect(untouched!.name).toBe("Pizza");
        });
    });
});
