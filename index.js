import * as dotenv from "dotenv";
dotenv.config();

import { PDFLoader } from "@langchain/community/document_loaders/fs/pdf";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { Pinecone } from "@pinecone-database/pinecone";

async function indexDocument() {
  try {
    const PDF_PATH = "./DATASTRUCTURESDIGITALNOTES.pdf";

    const pdfLoader = new PDFLoader(PDF_PATH);
    const rawDocs = await pdfLoader.load();
    console.log("PDF loaded");

    const cleanDocs = rawDocs.filter(
      (doc) => doc.pageContent && doc.pageContent.trim().length > 0
    );

    if (cleanDocs.length === 0) {
      throw new Error("No readable text found in PDF.");
    }

    const textSplitter = new RecursiveCharacterTextSplitter({
      chunkSize: 1000,
      chunkOverlap: 200,
    });

    const chunkedDocs = await textSplitter.splitDocuments(cleanDocs);
    console.log("Chunking completed");
    console.log("Chunks:", chunkedDocs.length);

    if (chunkedDocs.length === 0) {
      throw new Error("No chunks created from PDF.");
    }

    const pinecone = new Pinecone({
      apiKey: process.env.PINECONE_API_KEY,
    });

    const index = pinecone.Index(process.env.PINECONE_INDEX_NAME);

    const records = chunkedDocs.map((doc, i) => {
      const record = {
        _id: `doc-${Date.now()}-${i}`,
        text: doc.pageContent,
        source: doc.metadata?.source || PDF_PATH,
      };

      if (doc.metadata?.page !== undefined && doc.metadata?.page !== null) {
        record.page = doc.metadata.page;
      }

      return record;
    });

    console.log("Records prepared:", records.length);
    console.log("First record preview:", records[0]);

    const namespace = index.namespace("__default__");
    const batchSize = 96;

    for (let i = 0; i < records.length; i += batchSize) {
      const batch = records.slice(i, i + batchSize);
      await namespace.upsertRecords({ records: batch });
      console.log(
        `Upserted batch ${Math.floor(i / batchSize) + 1} (${batch.length} records)`
      );
    }

    console.log("Data stored successfully in Pinecone");
  } catch (error) {
    console.error("Error while indexing document:", error);
  }
}

indexDocument();
