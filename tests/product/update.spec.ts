import request from "supertest";
import mongoose from "mongoose";
import createJWKSMock from "mock-jwks";

jest.mock("../../src/common/services/S3Storage", () => require("../mocks/s3"));
jest.mock("../../src/common/factories/brokerFactory", () =>
    require("../mocks/broker"),
);

import app from "../../src/app";
import ProductModel from "../../src/product/product-model";
import { Roles } from "../../src/common/constants";
import { clearDb, connectDb, disconnectDb } from "../utils/db";
import { imageBuffer, productDocument, productFields } from "../utils/fixtures";
import { remove, resetS3Mocks, upload } from "../mocks/s3";
import {
    publishedMessage,
    resetBrokerMocks,
    sendMessage,
} from "../mocks/broker";

describe("PUT /products/:productId", () => {
    let jwks: ReturnType<typeof createJWKSMock>;
    let adminToken: string;

    beforeAll(async () => {
        jwks = createJWKSMock("http://localhost:5501");
        await connectDb();
    });

    beforeEach(async () => {
        jwks.start();
        await clearDb();
        resetS3Mocks();
        resetBrokerMocks();
        adminToken = jwks.token({ sub: "1", role: Roles.ADMIN });
    });

    afterEach(() => {
        jwks.stop();
    });

    afterAll(async () => {
        await disconnectDb();
    });

    const seedProduct = async (tenantId = "1") =>
        await ProductModel.create(
            productDocument({
                image: "existing-image-uuid",
                tenantId,
                categoryId: new mongoose.Types.ObjectId(),
            }),
        );

    const putProduct = (
        productId: string,
        token: string,
        fields: Record<string, string> = productFields({
            name: "Margherita Deluxe",
        }),
        attachImage = false,
    ) => {
        const req = request(app)
            .put(`/products/${productId}`)
            .set("Cookie", [`accessToken=${token}`]);

        Object.entries(fields).forEach(([key, value]) => req.field(key, value));

        if (attachImage) {
            req.attach("image", imageBuffer(), "new-pizza.png");
        }

        return req;
    };

    describe("Given a valid update", () => {
        it("should return the 200 status code and the id", async () => {
            const product = await seedProduct();

            const response = await putProduct(
                product._id.toString(),
                adminToken,
            );

            expect(response.statusCode).toBe(200);
            expect((response.body as { id: string }).id).toBe(
                product._id.toString(),
            );
        });

        it("should persist the new field values", async () => {
            const product = await seedProduct();

            await putProduct(product._id.toString(), adminToken);

            const updated = await ProductModel.findById(product._id);
            expect(updated!.name).toBe("Margherita Deluxe");
        });

        it("should publish a PRODUCT_UPDATE event on the product topic", async () => {
            const product = await seedProduct();

            await putProduct(product._id.toString(), adminToken);

            const { topic, body } = publishedMessage();

            expect(topic).toBe("product");
            expect(body.event_type).toBe("PRODUCT_UPDATE");
            expect((body.data as { id: string }).id).toBe(
                product._id.toString(),
            );
        });

        it("should publish the updated price configuration", async () => {
            // The event carries prices, not just an id, so order-service can
            // update its cache without a follow-up read.
            const product = await seedProduct();

            await putProduct(product._id.toString(), adminToken);

            const { body } = publishedMessage();
            const data = body.data as {
                priceConfiguration: Record<
                    string,
                    { availableOptions: Record<string, number> }
                >;
            };

            expect(data.priceConfiguration.Size.availableOptions.Medium).toBe(
                600,
            );
        });
    });

    describe("Image handling", () => {
        it("should keep the existing image when no file is sent", async () => {
            const product = await seedProduct();

            await putProduct(product._id.toString(), adminToken);

            const updated = await ProductModel.findById(product._id);

            expect(updated!.image).toBe("existing-image-uuid");
            expect(upload).not.toHaveBeenCalled();
            expect(remove).not.toHaveBeenCalled();
        });

        it("should upload the new image and delete the old one", async () => {
            const product = await seedProduct();

            await putProduct(
                product._id.toString(),
                adminToken,
                productFields({ name: "Margherita Deluxe" }),
                true,
            );

            expect(upload).toHaveBeenCalledTimes(1);
            expect(remove).toHaveBeenCalledWith("existing-image-uuid");

            const updated = await ProductModel.findById(product._id);
            const uploaded = upload.mock.calls[0][0] as { filename: string };

            expect(updated!.image).toBe(uploaded.filename);
            expect(updated!.image).not.toBe("existing-image-uuid");
        });
    });

    describe("Tenant isolation", () => {
        it("should let a manager update a product in their own tenant", async () => {
            const product = await seedProduct("1");
            const managerToken = jwks.token({
                sub: "2",
                role: Roles.MANAGER,
                tenant: "1",
            });

            const response = await putProduct(
                product._id.toString(),
                managerToken,
            );

            expect(response.statusCode).toBe(200);
        });

        it("should return 403 when a manager targets another tenant's product", async () => {
            // The core multi-tenant guarantee of this service: one
            // restaurant's manager must not be able to edit another's menu.
            const product = await seedProduct("1");
            const managerToken = jwks.token({
                sub: "2",
                role: Roles.MANAGER,
                tenant: "2",
            });

            const response = await putProduct(
                product._id.toString(),
                managerToken,
            );

            expect(response.statusCode).toBe(403);

            const untouched = await ProductModel.findById(product._id);
            expect(untouched!.name).toBe("Margherita");
        });

        it("should not publish an event when the tenant check fails", async () => {
            const product = await seedProduct("1");
            const managerToken = jwks.token({
                sub: "2",
                role: Roles.MANAGER,
                tenant: "2",
            });

            await putProduct(product._id.toString(), managerToken);

            expect(sendMessage).not.toHaveBeenCalled();
        });

        it("should let an admin update any tenant's product", async () => {
            const product = await seedProduct("99");

            const response = await putProduct(
                product._id.toString(),
                adminToken,
            );

            expect(response.statusCode).toBe(200);
        });
    });

    describe("Given an invalid request", () => {
        it("should return 404 for a well-formed id that does not exist", async () => {
            const missingId = new mongoose.Types.ObjectId().toString();

            const response = await putProduct(missingId, adminToken);

            expect(response.statusCode).toBe(404);
        });

        it("should return 500 for a malformed id", async () => {
            // BUG, captured rather than asserted as correct. There is no
            // isMongoId check on :productId, so the CastError from Mongoose
            // becomes a 500 via asyncWrapper. It should be a 400.
            const response = await putProduct("not-an-id", adminToken);

            expect(response.statusCode).toBe(500);
        });

        it.each([
            "name",
            "description",
            "priceConfiguration",
            "attributes",
            "tenantId",
            "categoryId",
        ])("should return 400 when %s is missing", async (field) => {
            const product = await seedProduct();
            const fields = productFields({ name: "Margherita Deluxe" });
            delete fields[field as keyof typeof fields];

            const response = await putProduct(
                product._id.toString(),
                adminToken,
                fields,
            );

            expect(response.statusCode).toBe(400);
        });
    });

    describe("Access control", () => {
        it("should return 401 if the caller is not authenticated", async () => {
            const product = await seedProduct();

            const req = request(app).put(`/products/${product._id.toString()}`);
            Object.entries(productFields()).forEach(([key, value]) =>
                req.field(key, value),
            );

            const response = await req;

            expect(response.statusCode).toBe(401);
        });

        it("should return 403 if the caller is a customer", async () => {
            const product = await seedProduct();
            const customerToken = jwks.token({
                sub: "3",
                role: Roles.CUSTOMER,
            });

            const response = await putProduct(
                product._id.toString(),
                customerToken,
            );

            expect(response.statusCode).toBe(403);
        });
    });
});
