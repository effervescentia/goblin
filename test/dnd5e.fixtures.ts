// 5e/main.yaml's other party members, fully chosen so the CLI answers
// `{ data }` once a test settles `aria`.
const COMPANIONS: Record<string, string> = {
  'bram.name': 'Bram',
  'bram.xp': '300',
  'bram.class': 'barbarian',
  'bram.species': 'goliath',
  'bram.background': 'acolyte',
  'bram.improvements.background': '["intelligence","wisdom","charisma"]',
  'bram.ability_method': 'standard_array',
  'bram.abilities.strength.assigned': '15',
  'bram.abilities.dexterity.assigned': '13',
  'bram.abilities.constitution.assigned': '14',
  'bram.abilities.intelligence.assigned': '8',
  'bram.abilities.wisdom.assigned': '12',
  'bram.abilities.charisma.assigned': '10',
  'bram.skills.trained': '["athletics","survival"]',
  'cora.name': 'Cora',
  'cora.xp': '300',
  'cora.class': 'wizard',
  'cora.species': 'human',
  'cora.background': 'acolyte',
  'cora.improvements.background': '["intelligence","wisdom","charisma"]',
  'cora.ability_method': 'standard_array',
  'cora.abilities.strength.assigned': '8',
  'cora.abilities.dexterity.assigned': '14',
  'cora.abilities.constitution.assigned': '13',
  'cora.abilities.intelligence.assigned': '15',
  'cora.abilities.wisdom.assigned': '12',
  'cora.abilities.charisma.assigned': '10',
  'cora.skills.trained': '["arcana","history"]',
};

export const COMPANION_PARAMS = Object.entries(COMPANIONS).flatMap(([key, value]) => ['--param', `${key}=${value}`]);
