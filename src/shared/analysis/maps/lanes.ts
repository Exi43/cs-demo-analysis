// Karten-Wissen: CS2-Place (env_cs_place) -> Laufweg (Lane). Jeder Place der 10 Maps hat eine Lane (Test prüft das).
// Namensregel: 'A …' / 'B …' = Weg zur Site (laneSite liest den Buchstaben), sonst Mid; 'T spawn' und 'CT' fest.
// Dust2/Mirage/Ancient aus dem Erkennungs-Prototyp (gemessen), die übrigen 7 nach Place-Lage und üblichen Callouts.
// shortcut: Lanes der 7 neuen Maps nicht an gelabelten Runden geprüft, nur Abdeckung; bei Fehlklassen mit Demos nachschärfen.
export const LANES: Record<string, Record<string, string>> = {
  de_dust2: {
    OutsideLong: 'A long', LongDoors: 'A long', Pit: 'A long', Side: 'A long', LongA: 'A long',
    Catwalk: 'A short', ShortStairs: 'A short',
    TopofMid: 'Mid', Middle: 'Mid', MidDoors: 'Mid', LowerTunnel: 'Mid',
    OutsideTunnel: 'B tunnels', UpperTunnel: 'B tunnels', TunnelStairs: 'B tunnels', TRamp: 'B tunnels',
    BombsiteA: 'A site', ARamp: 'A site', ExtendedA: 'A site', UnderA: 'A site',
    BombsiteB: 'B site', Hole: 'B site', BDoors: 'B site', CTSpawn: 'CT', TSpawn: 'T spawn',
  },
  de_mirage: {
    PalaceAlley: 'A ramp', TRamp: 'A ramp', PalaceInterior: 'A palace',
    TopofMid: 'Mid', Middle: 'Mid', SnipersNest: 'Mid', Ladder: 'Mid', Connector: 'Mid', Catwalk: 'Mid', Underpass: 'Mid',
    House: 'B apps', BackAlley: 'B apps', Apartments: 'B apps',
    BombsiteA: 'A site', Stairs: 'A site', Jungle: 'A site', Scaffolding: 'A site',
    BombsiteB: 'B site', Shop: 'B site', Truck: 'B site', CTSpawn: 'CT', TSpawn: 'T spawn', SideAlley: 'T spawn',
  },
  de_ancient: {
    Outside: 'A main', MainHall: 'A main', SideHall: 'A donut',
    Middle: 'Mid', TopofMid: 'Mid', House: 'Mid',
    Tunnel: 'B ramp', Water: 'B ramp', Ruins: 'B ramp', TSideLower: 'B ramp', Ramp: 'B ramp',
    TSideUpper: 'B cave', SideEntrance: 'B cave',
    BombsiteA: 'A site', BombsiteB: 'B site', Alley: 'B site', CTSpawn: 'CT', TSpawn: 'T spawn',
  },
  de_inferno: {
    Upstairs: 'A apps', Kitchen: 'A apps', Bridge: 'A apps', Deck: 'A apps', Apartments: 'A apps', Balcony: 'A apps', BackAlley: 'A apps',
    TopofMid: 'A short',
    LowerMid: 'Mid', SecondMid: 'Mid', Middle: 'Mid', Underpass: 'Mid',
    TRamp: 'B banana', Banana: 'B banana',
    BombsiteA: 'A site', Quad: 'A site', Pit: 'A site', Library: 'A site',
    BombsiteB: 'B site', Ruins: 'B site', Graveyard: 'B site', // Graveyard: älterer Place-Name, noch in Demos
    Arch: 'CT', CTSpawn: 'CT', TSpawn: 'T spawn',
  },
  de_nuke: {
    Lobby: 'A lobby', Squeaky: 'A lobby', Hut: 'A lobby', Vending: 'A lobby', Roof: 'A roof',
    Trophy: 'B ramp', Ramp: 'B ramp', Control: 'B ramp', Secret: 'B secret',
    Outside: 'Outside', Mini: 'Outside', Silo: 'Outside', Garage: 'Outside',
    BombsiteA: 'A site', HutRoof: 'A site', Heaven: 'A site', Rafters: 'A site', Catwalk: 'A site', Crane: 'A site', Hell: 'A site',
    BombsiteB: 'B site', Vents: 'B site', Decon: 'B site', Tunnels: 'B site', Observation: 'B site',
    LockerRoom: 'CT', Admin: 'CT', CTSpawn: 'CT', TSpawn: 'T spawn',
  },
  de_anubis: {
    Street: 'A main', TSideUpper: 'A main', Main: 'A main',
    TStairs: 'Mid', Canal: 'Mid', Bridge: 'Mid', MidDoors: 'Mid', Middle: 'Mid', Walkway: 'Mid',
    Connector: 'B con', Ruins: 'B main', OutsideLong: 'B main',
    BombsiteA: 'A site', Fountain: 'A site', Heaven: 'A site',
    BombsiteB: 'B site', BackofB: 'B site', Bricks: 'B site', Alley: 'B site', SnipersNest: 'B site', LowerTunnel: 'B site', PalaceInterior: 'B site',
    TunnelStairs: 'CT', Tunnel: 'CT', CTSideUpper: 'CT', Water: 'CT', CTSpawn: 'CT', TSpawn: 'T spawn',
  },
  de_cache: {
    OutsideA: 'A main', LongA: 'A main', AMain: 'A main', Lockers: 'A main', AHalls: 'A main', Squeaky: 'A main',
    Garage: 'Mid', Red: 'Mid', Middle: 'Mid', Cubby: 'Mid', Boost: 'Mid', AStairs: 'Mid', Mid: 'Mid', MidRoof: 'Mid',
    Sandbags: 'Mid', Checkers: 'Mid', Vents: 'Mid', Connector: 'Mid', Highway: 'Mid',
    OutsideB: 'B main', BHalls: 'B main', Useless: 'B main', SunRoom: 'B main', BMain: 'B main', Playground: 'B main',
    BombsiteA: 'A site', ABoost: 'A site', Corner: 'A site', Quad: 'A site', ForkLift: 'A site', Catwalk: 'A site',
    Toxic: 'A site', Ladder: 'A site', Truck: 'A site', ElectricalBox: 'A site',
    BombsiteB: 'B site', Bear: 'B site', BackHall: 'B site', TreeRoom: 'B site', Heaven: 'B site', Rafters: 'B site', Headshot: 'B site',
    CTLane: 'CT', BusStop: 'CT', CTSpawn: 'CT', TSpawn: 'T spawn', TYard: 'T spawn', TTruck: 'T spawn',
  },
  de_overpass: {
    Playground: 'A long', Fountain: 'A long', UpperPark: 'A long', LowerPark: 'A long', Restroom: 'A long',
    Tunnels: 'Mid', Connector: 'Mid',
    Alley: 'B monster', SideAlley: 'B monster', Canal: 'B monster', Pipe: 'B short', Water: 'B short',
    BombsiteA: 'A site', UnderA: 'A site', BackofA: 'A site', SnipersNest: 'A site',
    BombsiteB: 'B site', Construction: 'B site', Bridge: 'B site', Walkway: 'B site',
    Lobby: 'CT', StorageRoom: 'CT', Stairs: 'CT', TSpawn: 'T spawn', TStairs: 'T spawn',
  },
  de_train: {
    TStairs: 'A main', TMain: 'A main', Dumpster: 'A ivy', Alley: 'A ivy', Ivy: 'A ivy',
    TSideUpper: 'B upper', LongDog: 'B halls', BackofB: 'B halls',
    BombsiteA: 'A site', ElectricalBox: 'A site', BombsiteB: 'B site',
    Connector: 'CT', Tunnels: 'CT', Entrance: 'CT', CTSpawn: 'CT', TSpawn: 'T spawn',
  },
  de_vertigo: {
    TCorridorUp: 'B stairs', Pit: 'B stairs',
    Tunnels: 'Mid', Connector: 'Mid', LadderBottom: 'Mid', Bridge: 'Mid', Mid: 'Mid', TopofMid: 'Mid',
    LadderTop: 'A ramp', Scaffolding: 'A ramp', Side: 'A ramp', ARamp: 'A ramp',
    BombsiteA: 'A site', APlatform: 'A site', Crane: 'A site', Elevator: 'A site', BackofA: 'A site',
    BombsiteB: 'B site', BPlatform: 'B site', BackofB: 'B site', BackDoor: 'CT', CTSpawn: 'CT', TSpawn: 'T spawn',
  },
}
