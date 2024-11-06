use anchor_lang::prelude::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct InstructionSlice {
    pub start: u16,
    pub end: u16,
    pub action: SliceAction,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub enum SliceAction {
    Hash,
    Drop,
    // ValidateEq(u32), to validate the value of the slice
    // Future actions could be added here, like:
    // Validate(ValidationType),
    // Transform(TransformationType),
}

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct InstructionParser {
    pub slices: Vec<InstructionSlice>,
}

impl InstructionParser {
    pub fn parse_and_hash(&self, data: &[u8]) -> Result<Vec<u8>> {
        let mut hash_data = Vec::new();

        for slice in &self.slices {
            let slice_data = data
                .get(slice.start as usize..slice.end as usize)
                .ok_or(ProgramError::InvalidInstructionData)?;

            match slice.action {
                SliceAction::Hash => hash_data.extend(slice_data),
                SliceAction::Drop => (), // Do nothing with this slice
            }
        }
        Ok(hash_data)
    }
}
