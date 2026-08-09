import request from "supertest";
import createJWKSMock from "mock-jwks";

jest.mock("../../src/common/services/S3Storage", () => require("../mocks/s3"));
jest.mock("../../src/common/factories/brokerFactory", () =>
    require("../mocks/broker"),
);

import app from "../../src/app";
import ToppingModel from "../../src/topping/topping-model";
import { Roles } from "../../src/common/constants";
import { clearDb, connectDb, disconnectDb } from "../utils/db";
import { imageBuffer } from "../utils/fixtures";
import { resetS3Mocks, upload } from "../mocks/s3";
import {
    publishedMessage,
    resetBrokerMocks,
    sendMessage,
} from "../mocks/broker";

describe("POST /toppings", () => {
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

    const toppingFields = () => ({
        name: "Extra cheese",
        price: "50",
        tenantId: "1",
    });

    const postTopping = (
        token: string,
        fields: Record<string, string> = toppingFields(),
        attachImage = true,
    ) => {
        const req = request(app)
            .post("/toppings")
            .set("Cookie", [`accessToken=${token}`]);

        Object.entries(fields).forEach(([key, value]) => req.field(key, value));

        if (attachImage) {
            req.attach("image", imageBuffer(), "cheese.png");
        }

        return req;
    };

    describe("Given all fields", () => {
        it("should return the 200 status code and the new id", async () => {
            const response = await postTopping(adminToken);

            expect(response.statusCode).toBe(200);
            expect(response.body as { id: string }).toHaveProperty("id");
        });

        it("should persist the topping", async () => {
            await postTopping(adminToken);

            const toppings = await ToppingModel.find();

            expect(toppings).toHaveLength(1);
            expect(toppings[0].name).toBe("Extra cheese");
            expect(toppings[0].tenantId).toBe("1");
        });

        it("should cast the price to a number", async () => {
            // It arrives as a string because the request is multipart.
            await postTopping(adminToken);

            const topping = await ToppingModel.findOne({
                name: "Extra cheese",
            });

            expect(topping!.price).toBe(50);
            expect(typeof topping!.price).toBe("number");
        });

        it("should upload the image under a generated name", async () => {
            await postTopping(adminToken);

            expect(upload).toHaveBeenCalledTimes(1);

            const uploaded = upload.mock.calls[0][0] as { filename: string };
            const topping = await ToppingModel.findOne({
                name: "Extra cheese",
            });

            expect(topping!.image).toBe(uploaded.filename);
            expect(topping!.image).not.toBe("cheese.png");
        });

        it("should publish a TOPPING_CREATE event on the topping topic", async () => {
            // Keyed by tenantId, so per-tenant topping prices stay ordered.
            await postTopping(adminToken);

            const { topic, body } = publishedMessage();
            const topping = await ToppingModel.findOne({
                name: "Extra cheese",
            });

            expect(topic).toBe("topping");
            expect(body.event_type).toBe("TOPPING_CREATE");
            expect(body.data).toEqual({
                id: topping!._id.toString(),
                price: 50,
                tenantId: "1",
            });
        });

        it("should let a manager create a topping", async () => {
            const managerToken = jwks.token({
                sub: "2",
                role: Roles.MANAGER,
                tenant: "1",
            });

            const response = await postTopping(managerToken);

            expect(response.statusCode).toBe(200);
        });
    });

    describe("Given invalid fields", () => {
        // BUG, captured rather than asserted as correct, and it applies to
        // every case in this block.
        //
        // ToppingController.create never calls `validationResult(req)`.
        // create-topping-validator runs and collects errors — including its
        // image check, which is the one rule the product validator is missing
        // — but nothing ever reads them. Execution falls through to
        // `req.files!.image`, which throws, and asyncWrapper reports 500.
        //
        // So the validator is decorative: no invalid request to this route
        // can produce a 400, and the client gets an opaque 500 with no
        // indication of which field was wrong. ProductController.create does
        // this correctly — the four lines at the top of it are what is
        // missing here. Every expectation below then becomes 400.

        it("should return 500 when no image is attached", async () => {
            const response = await postTopping(
                adminToken,
                toppingFields(),
                false,
            );

            expect(response.statusCode).toBe(500);
            expect(await ToppingModel.find()).toHaveLength(0);
        });

        it.each(["name", "price", "tenantId"])(
            "should return 500 when %s is missing",
            async (field) => {
                const fields = toppingFields();
                delete fields[field as keyof typeof fields];

                const response = await postTopping(adminToken, fields);

                expect(response.statusCode).toBe(500);
            },
        );

        it("should not persist or publish anything when the name is missing", async () => {
            const fields = toppingFields();
            delete (fields as Partial<typeof fields>).name;

            await postTopping(adminToken, fields);

            expect(await ToppingModel.find()).toHaveLength(0);
            expect(sendMessage).not.toHaveBeenCalled();
        });

        it("uploads the image before discovering the body is invalid", async () => {
            // A direct consequence of skipping validationResult: the upload
            // happens first, so an invalid request still leaves an orphaned
            // object in the bucket that nothing will ever reference or clean
            // up. Checking validation first would avoid the write entirely.
            const fields = toppingFields();
            delete (fields as Partial<typeof fields>).name;

            await postTopping(adminToken, fields);

            expect(upload).toHaveBeenCalledTimes(1);
            expect(await ToppingModel.find()).toHaveLength(0);
        });

        it("should return 400 when the image exceeds the 500kb limit", async () => {
            const req = request(app)
                .post("/toppings")
                .set("Cookie", [`accessToken=${adminToken}`]);

            Object.entries(toppingFields()).forEach(([key, value]) =>
                req.field(key, value),
            );
            req.attach("image", Buffer.alloc(600 * 1024), "big.png");

            const response = await req;

            expect(response.statusCode).toBe(400);
        });
    });

    describe("Access control", () => {
        it("should return 401 if the caller is not authenticated", async () => {
            const req = request(app).post("/toppings");
            Object.entries(toppingFields()).forEach(([key, value]) =>
                req.field(key, value),
            );
            req.attach("image", imageBuffer(), "cheese.png");

            const response = await req;

            expect(response.statusCode).toBe(401);
            expect(await ToppingModel.find()).toHaveLength(0);
        });

        it("should return 403 if the caller is a customer", async () => {
            const customerToken = jwks.token({
                sub: "3",
                role: Roles.CUSTOMER,
            });

            const response = await postTopping(customerToken);

            expect(response.statusCode).toBe(403);
            expect(upload).not.toHaveBeenCalled();
        });
    });
});
