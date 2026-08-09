import request from "supertest";
import mongoose from "mongoose";

jest.mock("../../src/common/services/S3Storage", () => require("../mocks/s3"));
jest.mock("../../src/common/factories/brokerFactory", () =>
    require("../mocks/broker"),
);

import app from "../../src/app";
import ProductModel from "../../src/product/product-model";
import CategoryModel from "../../src/category/category-model";
import { clearDb, connectDb, disconnectDb } from "../utils/db";
import { categoryPayload, productDocument } from "../utils/fixtures";
import { resetS3Mocks } from "../mocks/s3";

interface ProductListResponse {
    data: {
        _id: string;
        name: string;
        image: string;
        tenantId: string;
        isPublish: boolean;
        category: { _id: string; name: string };
    }[];
    total: number;
    pageSize: number;
    currentPage: number;
}

describe("GET /products", () => {
    let categoryId: mongoose.Types.ObjectId;

    beforeAll(async () => {
        await connectDb();
    });

    beforeEach(async () => {
        await clearDb();
        resetS3Mocks();
        const category = await CategoryModel.create(categoryPayload());
        categoryId = category._id;
    });

    afterAll(async () => {
        await disconnectDb();
    });

    const seedProduct = async (
        overrides: Partial<{
            name: string;
            tenantId: string;
            isPublish: boolean;
            categoryId: mongoose.Types.ObjectId;
            image: string;
        }> = {},
    ) =>
        await ProductModel.create(
            productDocument({ categoryId, ...overrides }),
        );

    describe("Pagination", () => {
        it("should return the 200 status code", async () => {
            const response = await request(app).get("/products").send();

            expect(response.statusCode).toBe(200);
        });

        it("should return the data and total", async () => {
            await seedProduct();

            const response = await request(app).get("/products").send();
            const body = response.body as ProductListResponse;

            expect(body.total).toBe(1);
            expect(body.data).toHaveLength(1);
        });

        it("currently omits pageSize and currentPage from the response (bug)", async () => {
            // BUG, captured rather than asserted as correct.
            //
            // config/pagination.ts renames the paginate result's fields via
            // customLabels: limit -> pageSize, page -> currentPage. The
            // controller then builds its response from `products.limit` and
            // `products.page`, which no longer exist, so both come out
            // undefined and JSON.stringify drops them entirely. The client
            // gets `{ data, total }` and cannot tell which page it received.
            //
            // `total` works only because its label happens to match what the
            // controller reads.
            //
            // Fix: read `products.pageSize` and `products.currentPage`. These
            // expectations then become 10 and 1.
            await seedProduct();

            const response = await request(app).get("/products").send();
            const body = response.body as ProductListResponse;

            expect(Object.keys(body).sort()).toEqual(["data", "total"]);
            expect(body.pageSize).toBeUndefined();
            expect(body.currentPage).toBeUndefined();
        });

        it("should default to 10 per page", async () => {
            for (let i = 0; i < 12; i++) {
                await seedProduct({ name: `Pizza ${i}` });
            }

            const response = await request(app).get("/products").send();
            const body = response.body as ProductListResponse;

            expect(body.total).toBe(12);
            expect(body.data).toHaveLength(10);
        });

        it("should return the remaining records on the next page", async () => {
            for (let i = 0; i < 12; i++) {
                await seedProduct({ name: `Pizza ${i}` });
            }

            const response = await request(app)
                .get("/products")
                .query({ page: 2 })
                .send();
            const body = response.body as ProductListResponse;

            expect(body.data).toHaveLength(2);
        });

        it("should respect an explicit limit", async () => {
            for (let i = 0; i < 5; i++) {
                await seedProduct({ name: `Pizza ${i}` });
            }

            const response = await request(app)
                .get("/products")
                .query({ limit: 2 })
                .send();
            const body = response.body as ProductListResponse;

            expect(body.data).toHaveLength(2);
        });

        it("should return an empty list when there are no products", async () => {
            const response = await request(app).get("/products").send();
            const body = response.body as ProductListResponse;

            expect(body.total).toBe(0);
            expect(body.data).toEqual([]);
        });
    });

    describe("Filtering and searching", () => {
        it("should filter by tenantId", async () => {
            await seedProduct({ name: "Tenant one pizza", tenantId: "1" });
            await seedProduct({ name: "Tenant two pizza", tenantId: "2" });

            const response = await request(app)
                .get("/products")
                .query({ tenantId: "2" })
                .send();
            const body = response.body as ProductListResponse;

            expect(body.total).toBe(1);
            expect(body.data[0].name).toBe("Tenant two pizza");
        });

        it("should filter by categoryId", async () => {
            const other = await CategoryModel.create(
                categoryPayload({ name: "Beverages" }),
            );
            await seedProduct({ name: "Pizza" });
            await seedProduct({ name: "Cola", categoryId: other._id });

            const response = await request(app)
                .get("/products")
                .query({ categoryId: other._id.toString() })
                .send();
            const body = response.body as ProductListResponse;

            expect(body.total).toBe(1);
            expect(body.data[0].name).toBe("Cola");
        });

        it("should ignore a malformed categoryId rather than fail", async () => {
            // The controller guards with ObjectId.isValid, so a bad value
            // drops the filter instead of throwing a CastError.
            await seedProduct();

            const response = await request(app)
                .get("/products")
                .query({ categoryId: "not-an-id" })
                .send();

            expect(response.statusCode).toBe(200);
            expect((response.body as ProductListResponse).total).toBe(1);
        });

        it("should filter to published products when isPublish=true", async () => {
            await seedProduct({ name: "Published", isPublish: true });
            await seedProduct({ name: "Draft", isPublish: false });

            const response = await request(app)
                .get("/products")
                .query({ isPublish: "true" })
                .send();
            const body = response.body as ProductListResponse;

            expect(body.total).toBe(1);
            expect(body.data[0].name).toBe("Published");
        });

        it("should return drafts too when isPublish is absent", async () => {
            await seedProduct({ name: "Published", isPublish: true });
            await seedProduct({ name: "Draft", isPublish: false });

            const response = await request(app).get("/products").send();

            expect((response.body as ProductListResponse).total).toBe(2);
        });

        it("should treat any value other than the string 'true' as no filter", async () => {
            // `isPublish === "true"` is an exact string compare, so
            // ?isPublish=false does not filter to drafts — it does nothing.
            await seedProduct({ name: "Published", isPublish: true });
            await seedProduct({ name: "Draft", isPublish: false });

            const response = await request(app)
                .get("/products")
                .query({ isPublish: "false" })
                .send();

            expect((response.body as ProductListResponse).total).toBe(2);
        });

        it("should search on the name, case-insensitively", async () => {
            await seedProduct({ name: "Margherita" });
            await seedProduct({ name: "Pepperoni" });

            const response = await request(app)
                .get("/products")
                .query({ q: "pepper" })
                .send();
            const body = response.body as ProductListResponse;

            expect(body.total).toBe(1);
            expect(body.data[0].name).toBe("Pepperoni");
        });

        it("should combine the search term with a tenant filter", async () => {
            await seedProduct({ name: "Margherita", tenantId: "1" });
            await seedProduct({ name: "Margherita", tenantId: "2" });

            const response = await request(app)
                .get("/products")
                .query({ q: "margherita", tenantId: "2" })
                .send();
            const body = response.body as ProductListResponse;

            expect(body.total).toBe(1);
            expect(body.data[0].tenantId).toBe("2");
        });
    });

    describe("Response shape", () => {
        it("should rewrite the stored image name into an S3 url", async () => {
            await seedProduct({ image: "some-uuid" });

            const response = await request(app).get("/products").send();
            const body = response.body as ProductListResponse;

            expect(body.data[0].image).toBe(
                "https://catalog-service-test.s3.ap-south-1.amazonaws.com/some-uuid",
            );
        });

        it("should join the category onto each product", async () => {
            await seedProduct();

            const response = await request(app).get("/products").send();
            const body = response.body as ProductListResponse;

            expect(body.data[0].category._id).toBe(categoryId.toString());
            expect(body.data[0].category.name).toBe("Pizza");
        });

        it("should drop products whose category no longer exists", async () => {
            // The pipeline ends in `$unwind: "$category"`, which discards any
            // document the $lookup did not match. A product pointing at a
            // deleted category silently disappears from the listing — worth
            // knowing before debugging a "missing product" report.
            await seedProduct({
                name: "Orphan",
                categoryId: new mongoose.Types.ObjectId(),
            });
            await seedProduct({ name: "Fine" });

            const response = await request(app).get("/products").send();
            const body = response.body as ProductListResponse;

            expect(body.data).toHaveLength(1);
            expect(body.data[0].name).toBe("Fine");
        });

        it("counts orphaned products in total even though they are not returned (bug)", async () => {
            // BUG, captured rather than asserted as correct.
            //
            // mongoose-aggregate-paginate-v2 builds its count from a pipeline
            // that does not carry the $lookup/$unwind, so `total` counts rows
            // the response omits. Two products, one orphaned: data has 1 and
            // total says 2.
            //
            // Combined with the missing pageSize above, this is what breaks
            // pagination in the admin UI — it derives a page count from an
            // inflated total and has no page size to divide by.
            await seedProduct({
                name: "Orphan",
                categoryId: new mongoose.Types.ObjectId(),
            });
            await seedProduct({ name: "Fine" });

            const response = await request(app).get("/products").send();
            const body = response.body as ProductListResponse;

            expect(body.data).toHaveLength(1);
            expect(body.total).toBe(2);
        });
    });

    describe("Access control", () => {
        it("should be readable without authentication", async () => {
            // The customer-facing menu is public.
            await seedProduct();

            const response = await request(app).get("/products").send();

            expect(response.statusCode).toBe(200);
            expect((response.body as ProductListResponse).total).toBe(1);
        });
    });
});
