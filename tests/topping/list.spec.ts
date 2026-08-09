import request from "supertest";

jest.mock("../../src/common/services/S3Storage", () => require("../mocks/s3"));
jest.mock("../../src/common/factories/brokerFactory", () =>
    require("../mocks/broker"),
);

import app from "../../src/app";
import ToppingModel from "../../src/topping/topping-model";
import { clearDb, connectDb, disconnectDb } from "../utils/db";
import { resetS3Mocks } from "../mocks/s3";

interface ToppingResponse {
    id: string;
    name: string;
    price: number;
    tenantId: string;
    image: string;
}

describe("GET /toppings", () => {
    beforeAll(async () => {
        await connectDb();
    });

    beforeEach(async () => {
        await clearDb();
        resetS3Mocks();
    });

    afterAll(async () => {
        await disconnectDb();
    });

    const seedTopping = async (
        overrides: Partial<{
            name: string;
            price: number;
            tenantId: string;
            image: string;
        }> = {},
    ) =>
        await ToppingModel.create({
            name: "Extra cheese",
            price: 50,
            tenantId: "1",
            image: "cheese-uuid",
            ...overrides,
        });

    it("should return the 200 status code", async () => {
        const response = await request(app)
            .get("/toppings")
            .query({ tenantId: "1" })
            .send();

        expect(response.statusCode).toBe(200);
    });

    it("should return an empty array when the tenant has no toppings", async () => {
        const response = await request(app)
            .get("/toppings")
            .query({ tenantId: "1" })
            .send();

        expect(response.body as ToppingResponse[]).toEqual([]);
    });

    it("should return only the requested tenant's toppings", async () => {
        await seedTopping({ name: "Cheese", tenantId: "1" });
        await seedTopping({ name: "Olives", tenantId: "2" });

        const response = await request(app)
            .get("/toppings")
            .query({ tenantId: "2" })
            .send();
        const body = response.body as ToppingResponse[];

        expect(body).toHaveLength(1);
        expect(body[0].name).toBe("Olives");
    });

    it("should reshape _id into id", async () => {
        const topping = await seedTopping();

        const response = await request(app)
            .get("/toppings")
            .query({ tenantId: "1" })
            .send();
        const body = response.body as ToppingResponse[];

        expect(body[0].id).toBe(topping._id!.toString());
        expect(body[0]).not.toHaveProperty("_id");
    });

    it("should rewrite the stored image name into an S3 url", async () => {
        await seedTopping({ image: "some-uuid" });

        const response = await request(app)
            .get("/toppings")
            .query({ tenantId: "1" })
            .send();
        const body = response.body as ToppingResponse[];

        expect(body[0].image).toBe(
            "https://catalog-service-test.s3.ap-south-1.amazonaws.com/some-uuid",
        );
    });

    it("should return the name, price and tenantId", async () => {
        await seedTopping();

        const response = await request(app)
            .get("/toppings")
            .query({ tenantId: "1" })
            .send();
        const body = response.body as ToppingResponse[];

        expect(body[0].name).toBe("Extra cheese");
        expect(body[0].price).toBe(50);
        expect(body[0].tenantId).toBe("1");
    });

    it("should return an empty list when tenantId is omitted", async () => {
        // tenantId is read straight off the query with no validation, so an
        // absent value reaches Mongoose as `find({ tenantId: undefined })`.
        // Mongoose 9 matches that against null rather than dropping the
        // condition, so the query returns nothing instead of leaking every
        // tenant's toppings. Worth pinning down: the safe outcome here is the
        // driver's doing, not the route's, and it would change if the filter
        // were ever built differently.
        await seedTopping({ name: "Cheese", tenantId: "1" });
        await seedTopping({ name: "Olives", tenantId: "2" });

        const response = await request(app).get("/toppings").send();
        const body = response.body as ToppingResponse[];

        expect(response.statusCode).toBe(200);
        expect(body).toEqual([]);
    });

    it("should be readable without authentication", async () => {
        // Deliberate: the customer-facing menu needs toppings before login.
        await seedTopping();

        const response = await request(app)
            .get("/toppings")
            .query({ tenantId: "1" })
            .send();

        expect(response.statusCode).toBe(200);
    });
});
