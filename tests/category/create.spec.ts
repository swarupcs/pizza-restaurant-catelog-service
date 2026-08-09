import request from "supertest";
import createJWKSMock from "mock-jwks";

// The routers build an S3 client and a Kafka producer at module load, so both
// have to be replaced before `app` is imported.
jest.mock("../../src/common/services/S3Storage", () => require("../mocks/s3"));
jest.mock("../../src/common/factories/brokerFactory", () =>
    require("../mocks/broker"),
);

import app from "../../src/app";
import CategoryModel from "../../src/category/category-model";
import { Roles } from "../../src/common/constants";
import { clearDb, connectDb, disconnectDb } from "../utils/db";
import { categoryPayload } from "../utils/fixtures";

describe("POST /categories", () => {
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

    describe("Given all fields", () => {
        it("should return the 200 status code", async () => {
            const response = await request(app)
                .post("/categories")
                .set("Cookie", [`accessToken=${adminToken}`])
                .send(categoryPayload());

            expect(response.statusCode).toBe(200);
        });

        it("should return the id of the created category", async () => {
            const response = await request(app)
                .post("/categories")
                .set("Cookie", [`accessToken=${adminToken}`])
                .send(categoryPayload());

            expect(response.body as { id: string }).toHaveProperty("id");
        });

        it("should persist the category in the database", async () => {
            await request(app)
                .post("/categories")
                .set("Cookie", [`accessToken=${adminToken}`])
                .send(categoryPayload());

            const categories = await CategoryModel.find();

            expect(categories).toHaveLength(1);
            expect(categories[0].name).toBe("Pizza");
        });

        it("should store priceConfiguration as a Map", async () => {
            // The schema declares `type: Map`, which is what lets a category
            // carry arbitrary configuration keys (Size, Crust, ...) without a
            // schema change per key.
            await request(app)
                .post("/categories")
                .set("Cookie", [`accessToken=${adminToken}`])
                .send(categoryPayload());

            const category = await CategoryModel.findOne({ name: "Pizza" });
            const config = category!.priceConfiguration as unknown as Map<
                string,
                { priceType: string; availableOptions: string[] }
            >;

            expect(config).toBeInstanceOf(Map);
            expect(config.get("Size")?.priceType).toBe("base");
            expect(config.get("Size")?.availableOptions).toEqual([
                "Small",
                "Medium",
                "Large",
            ]);
            expect(config.get("Crust")?.priceType).toBe("aditional");
        });

        it("should store the attributes array", async () => {
            await request(app)
                .post("/categories")
                .set("Cookie", [`accessToken=${adminToken}`])
                .send(categoryPayload());

            const category = await CategoryModel.findOne({ name: "Pizza" });

            expect(category!.attributes).toHaveLength(2);
            expect(category!.attributes[0].name).toBe("isHit");
            expect(category!.attributes[0].widgetType).toBe("radio");
        });
    });

    describe("Given invalid fields", () => {
        it("should return 400 if the name is missing", async () => {
            const payload = categoryPayload();
            delete (payload as Partial<typeof payload>).name;

            const response = await request(app)
                .post("/categories")
                .set("Cookie", [`accessToken=${adminToken}`])
                .send(payload);

            expect(response.statusCode).toBe(400);
        });

        it("should return 400 if the name is not a string", async () => {
            const response = await request(app)
                .post("/categories")
                .set("Cookie", [`accessToken=${adminToken}`])
                .send(categoryPayload({ name: 42 as unknown as string }));

            expect(response.statusCode).toBe(400);
        });

        it("should return 400 if priceConfiguration is missing", async () => {
            const payload = categoryPayload();
            delete (payload as Partial<typeof payload>).priceConfiguration;

            const response = await request(app)
                .post("/categories")
                .set("Cookie", [`accessToken=${adminToken}`])
                .send(payload);

            expect(response.statusCode).toBe(400);
        });

        it("should return 400 for an unknown priceType", async () => {
            const response = await request(app)
                .post("/categories")
                .set("Cookie", [`accessToken=${adminToken}`])
                .send(
                    categoryPayload({
                        priceConfiguration: {
                            Size: {
                                priceType: "premium" as unknown as "base",
                                availableOptions: ["Small"],
                            },
                        },
                    }),
                );

            expect(response.statusCode).toBe(400);
        });

        it("should return 400 if attributes is missing", async () => {
            const payload = categoryPayload();
            delete (payload as Partial<typeof payload>).attributes;

            const response = await request(app)
                .post("/categories")
                .set("Cookie", [`accessToken=${adminToken}`])
                .send(payload);

            expect(response.statusCode).toBe(400);
        });

        it("should not persist anything when validation fails", async () => {
            await request(app)
                .post("/categories")
                .set("Cookie", [`accessToken=${adminToken}`])
                .send({});

            expect(await CategoryModel.find()).toHaveLength(0);
        });
    });

    describe("Access control", () => {
        it("should return 401 if the caller is not authenticated", async () => {
            const response = await request(app)
                .post("/categories")
                .send(categoryPayload());

            expect(response.statusCode).toBe(401);
            expect(await CategoryModel.find()).toHaveLength(0);
        });

        it("should return 403 if the caller is a manager", async () => {
            // Categories are platform-wide, not per-tenant, so only an admin
            // may create one — a manager is scoped to a single restaurant.
            const managerToken = jwks.token({
                sub: "1",
                role: Roles.MANAGER,
                tenant: "1",
            });

            const response = await request(app)
                .post("/categories")
                .set("Cookie", [`accessToken=${managerToken}`])
                .send(categoryPayload());

            expect(response.statusCode).toBe(403);
            expect(await CategoryModel.find()).toHaveLength(0);
        });

        it("should return 403 if the caller is a customer", async () => {
            const customerToken = jwks.token({
                sub: "1",
                role: Roles.CUSTOMER,
            });

            const response = await request(app)
                .post("/categories")
                .set("Cookie", [`accessToken=${customerToken}`])
                .send(categoryPayload());

            expect(response.statusCode).toBe(403);
        });

        it("should accept the token from an Authorization header too", async () => {
            const response = await request(app)
                .post("/categories")
                .set("Authorization", `Bearer ${adminToken}`)
                .send(categoryPayload());

            expect(response.statusCode).toBe(200);
        });
    });
});
