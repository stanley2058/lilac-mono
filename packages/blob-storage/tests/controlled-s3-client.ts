export class ControlledS3Client {
  readonly values = new Map<string, Uint8Array>();

  async exists(key: string): Promise<boolean> {
    return this.values.has(key);
  }

  presign(key: string): string {
    return `https://controlled-s3.invalid/${encodeURIComponent(key)}`;
  }

  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : input.toString();
    const key = decodeURIComponent(new URL(url).pathname.slice(1));
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    if (method === "GET") {
      const value = this.values.get(key);
      return value === undefined
        ? new Response(null, { status: 404 })
        : new Response(value.slice(), { status: 200 });
    }
    const headers = new Headers(init?.headers);
    const copySource = headers.get("x-amz-copy-source");
    if (method === "PUT" && copySource !== null) {
      const sourcePath = decodeURIComponent(copySource).replace(/^\//u, "");
      const sourceKey = sourcePath.slice(sourcePath.indexOf("/") + 1);
      const source = this.values.get(sourceKey);
      if (source === undefined) return new Response(null, { status: 404 });
      this.values.set(key, source.slice());
      return new Response("<CopyObjectResult />", { status: 200 });
    }
    if (headers.get("if-none-match") === "*" && this.values.has(key)) {
      return new Response(null, { status: 412 });
    }
    const bytes = new Uint8Array(await new Response(init?.body).arrayBuffer());
    this.values.set(key, bytes);
    return new Response(null, { status: 200 });
  };

  file(key: string) {
    return {
      __fakeS3Key: key,
      text: async () => {
        return new TextDecoder().decode(this.values.get(key) ?? new Uint8Array());
      },
      arrayBuffer: async () => (this.values.get(key) ?? new Uint8Array()).slice().buffer,
      stream: () => {
        const value = this.values.get(key) ?? new Uint8Array();
        return new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(value.slice());
            controller.close();
          },
        });
      },
      writer: () => {
        const chunks: Uint8Array[] = [];
        return {
          write(chunk: Uint8Array) {
            chunks.push(chunk.slice());
            return chunk.byteLength;
          },
          flush() {
            return 0;
          },
          end: async (error?: Error) => {
            if (error !== undefined) return 0;
            const byteLength = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
            const value = new Uint8Array(byteLength);
            let offset = 0;
            for (const chunk of chunks) {
              value.set(chunk, offset);
              offset += chunk.byteLength;
            }
            this.values.set(key, value);
            return byteLength;
          },
        };
      },
    };
  }

  async write(
    key: string,
    data: string | Uint8Array | { readonly __fakeS3Key?: string },
  ): Promise<number> {
    let value: Uint8Array;
    if (typeof data === "string") {
      value = new TextEncoder().encode(data);
    } else if (data instanceof Uint8Array) {
      value = data.slice();
    } else {
      value =
        data.__fakeS3Key === undefined
          ? new Uint8Array()
          : (this.values.get(data.__fakeS3Key)?.slice() ?? new Uint8Array());
    }
    this.values.set(key, value);
    return value.byteLength;
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }

  async stat(key: string) {
    return {
      size: this.values.get(key)?.byteLength ?? 0,
      lastModified: new Date(),
      etag: "controlled-etag",
      type: "application/octet-stream",
    };
  }

  async list(input?: {
    readonly prefix?: string;
    readonly maxKeys?: number;
    readonly startAfter?: string;
  }) {
    const keys = [...this.values.keys()]
      .filter((key) => key.startsWith(input?.prefix ?? ""))
      .filter((key) => input?.startAfter === undefined || key > input.startAfter)
      .sort();
    const limit = input?.maxKeys ?? 1_000;
    return {
      contents: keys.slice(0, limit).map((key) => ({
        key,
        size: this.values.get(key)?.byteLength,
        eTag: "controlled-etag",
      })),
      isTruncated: keys.length > limit,
    };
  }
}
