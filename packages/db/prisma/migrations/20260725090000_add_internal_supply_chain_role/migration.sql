-- Add the tenant-wide, read-only role used by the internal supply-chain team.
ALTER TYPE "Role" ADD VALUE 'SUPPLY_CHAIN';
