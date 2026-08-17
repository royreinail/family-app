import { getPool } from '../db/pool.js';

export async function findByIdentifier({ familyId, channelType, externalIdentifier }, pool = getPool()) {
  const { rows } = await pool.query(
    `select * from source_mappings
     where family_id = $1 and channel_type = $2 and external_identifier = $3 and deleted_at is null`,
    [familyId, channelType, externalIdentifier]
  );
  return rows[0] ?? null;
}

export async function create({ familyId, channelType, externalIdentifier, familyMemberId }, pool = getPool()) {
  const { rows } = await pool.query(
    `insert into source_mappings (family_id, channel_type, external_identifier, family_member_id)
     values ($1,$2,$3,$4) returning *`,
    [familyId, channelType, externalIdentifier, familyMemberId]
  );
  return rows[0];
}

export async function findAllForFamily(familyId, pool = getPool()) {
  const { rows } = await pool.query(
    `select * from source_mappings where family_id = $1 and deleted_at is null`,
    [familyId]
  );
  return rows;
}
