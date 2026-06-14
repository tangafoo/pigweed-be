import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client";
import { databaseUrl } from "./env";

const adapter = new PrismaPg({ connectionString: databaseUrl() });
export const prisma = new PrismaClient({ adapter });
