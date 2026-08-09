import config from "config";
import { HttpError } from "http-errors";

// The AWS SDK is replaced wholesale: these tests are about what S3Storage
// asks the client to do, not about reaching S3.
// node-config freezes its export, so a spy cannot be attached to `get`.
// The module is replaced with a jest.fn that delegates to the real config by
// default, which leaves every other test reading the true test.yaml values
// while still allowing one of them to simulate a missing key.
jest.mock("config", () => {
    const actual = jest.requireActual("config") as {
        get: (key: string) => unknown;
    };
    return { get: jest.fn((key: string) => actual.get(key)) };
});

jest.mock("@aws-sdk/client-s3", () => {
    const send = jest.fn().mockResolvedValue(undefined);
    return {
        S3Client: jest.fn().mockImplementation(() => ({ send })),
        PutObjectCommand: jest
            .fn()
            .mockImplementation((input: unknown) => ({ input })),
        DeleteObjectCommand: jest
            .fn()
            .mockImplementation((input: unknown) => ({ input })),
        __send: send,
    };
});

import {
    DeleteObjectCommand,
    PutObjectCommand,
    S3Client,
} from "@aws-sdk/client-s3";
import { S3Storage } from "../../src/common/services/S3Storage";

const sdk = jest.requireMock("@aws-sdk/client-s3") as { __send: jest.Mock };

describe("S3Storage", () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it("should build the client from config", () => {
        new S3Storage();

        // Values come from config/test.yaml.
        expect(S3Client).toHaveBeenCalledWith({
            region: "ap-south-1",
            credentials: {
                accessKeyId: "test-access-key",
                secretAccessKey: "test-secret-key",
            },
        });
    });

    describe("upload", () => {
        it("should put the object into the configured bucket under the given key", async () => {
            const storage = new S3Storage();
            const fileData = new ArrayBuffer(8);

            await storage.upload({ filename: "some-uuid", fileData });

            expect(PutObjectCommand).toHaveBeenCalledWith({
                Bucket: "catalog-service-test",
                Key: "some-uuid",
                Body: fileData,
            });
            expect(sdk.__send).toHaveBeenCalledTimes(1);
        });
    });

    describe("delete", () => {
        it("should delete the key from the configured bucket", async () => {
            const storage = new S3Storage();

            await storage.delete("some-uuid");

            expect(DeleteObjectCommand).toHaveBeenCalledWith({
                Bucket: "catalog-service-test",
                Key: "some-uuid",
            });
            expect(sdk.__send).toHaveBeenCalledTimes(1);
        });
    });

    describe("getObjectUri", () => {
        it("should build the public url from the bucket and region", () => {
            const storage = new S3Storage();

            expect(storage.getObjectUri("some-uuid")).toBe(
                "https://catalog-service-test.s3.ap-south-1.amazonaws.com/some-uuid",
            );
        });

        it("should be the inverse of what upload stored", () => {
            // The product and topping listings store only the uuid and rebuild
            // the url on read, so these two have to agree.
            const storage = new S3Storage();
            const filename = "5962624d-1b9e-4c96-b1d6-395ca9ef4933";

            expect(storage.getObjectUri(filename)).toContain(filename);
        });

        it("should throw a 500 when the bucket config is missing", () => {
            // The failure mode when S3_BUCKET is not set in the environment:
            // uploads still succeed, but every listing throws, so the catalog
            // looks broken while storage looks fine.
            const storage = new S3Storage();
            const actual = jest.requireActual("config") as {
                get: (key: string) => unknown;
            };
            const get = config.get as unknown as jest.Mock;

            get.mockImplementation((key: string) =>
                key === "s3.bucket" ? undefined : actual.get(key),
            );

            try {
                let thrown: HttpError | undefined;
                try {
                    storage.getObjectUri("some-uuid");
                } catch (err) {
                    thrown = err as HttpError;
                }

                expect(thrown?.message).toBe("Invalid S3 configuration");
                expect(thrown?.status).toBe(500);
            } finally {
                get.mockImplementation((key: string) => actual.get(key));
            }
        });
    });
});
