
var Configuration = function (outPath, climate, doDebug) {

  DEBUG = (doDebug === true) ? true : false;

  /* no output if null */ 
  var _outPath = outPath; 

  var run = function run(simObj, siteObj, cropObj) {

    logger(MSG.INFO, 'Fetching parameters from database.');
    
    var sp = new SiteParameters();
    var cpp = readUserParameterFromDatabase();
    var gp = new GeneralParameters(
      cpp.userEnvironmentParameters.p_LayerThickness,
      cpp.userEnvironmentParameters.p_LayerThickness * cpp.userEnvironmentParameters.p_NumberOfLayers
    );

    /* fetch soil horizon array */
    var horizonsArr = siteObj.horizons;
    /* fetch crop array */
    var cropsArr = cropObj.crops;

    /* sim */
    var startYear = new Date(Date.parse(simObj.time.startDate)).getFullYear();
    var endYear = new Date(Date.parse(simObj.time.endDate)).getFullYear();

    cpp.userEnvironmentParameters.p_UseSecondaryYields = simObj.switch.useSecondaryYieldOn === true ? true : false;
    gp.pc_NitrogenResponseOn = simObj.switch.nitrogenResponseOn === true ? true : false;
    gp.pc_WaterDeficitResponseOn = simObj.switch.waterDeficitResponseOn === true ? true : false;
    gp.pc_EmergenceMoistureControlOn = simObj.switch.emergenceMoistureControlOn === true ? true : false;
    gp.pc_EmergenceFloodingControlOn = simObj.switch.emergenceFloodingControlOn === true ? true : false;

    cpp.userInitValues.p_initPercentageFC = simObj.init.percentageFC;
    cpp.userInitValues.p_initSoilNitrate = simObj.init.soilNitrate;
    cpp.userInitValues.p_initSoilAmmonium = simObj.init.soilAmmonium;

    logger(MSG.INFO, 'Fetched sim data.');
    
    /* site */
    sp.vq_NDeposition = siteObj.NDeposition;
    sp.vs_Latitude = siteObj.latitude;
    sp.vs_Slope = siteObj.slope;
    sp.vs_HeightNN = siteObj.heightNN;
    sp.vs_Soil_CN_Ratio = 10; //TODO: per layer?
    sp.vs_DrainageCoeff = -1; //TODO: ?

    cpp.userEnvironmentParameters.p_AthmosphericCO2 = siteObj.atmosphericCO2;
    // if (siteObj.groundwaterDepthMin)
    //   cpp.userEnvironmentParameters.p_MinGroundwaterDepth = siteObj.groundwaterDepthMin;
    // if (siteObj.groundwaterDepthMax)
    //   cpp.userEnvironmentParameters.p_MaxGroundwaterDepth = siteObj.groundwaterDepthMax;
    // if (siteObj.groundwaterDepthMinMonth)
    //   cpp.userEnvironmentParameters.p_MinGroundwaterDepthMonth = siteObj.groundwaterDepthMinMonth;
    cpp.userEnvironmentParameters.p_WindSpeedHeight = siteObj.windSpeedHeight;  
    cpp.userEnvironmentParameters.p_LeachingDepth = siteObj.leachingDepth;  
    // cpp.userEnvironmentParameters.p_NumberOfLayers = horizonsArr.numberOfLayers; // JV! currently not present in json 

    // TODO: maxMineralisationDepth? (gp ps_MaxMineralisationDepth und ps_MaximumMineralisationDepth?)
    gp.ps_MaxMineralisationDepth = 0.4;

    logger(MSG.INFO, 'Fetched site data.');

    /* soil */
    var lThicknessCm = 100.0 * cpp.userEnvironmentParameters.p_LayerThickness;
    var maxDepthCm =  200.0;
    var maxNoOfLayers = int(maxDepthCm / lThicknessCm);

    var layers = [];
    if (!createLayers(layers, horizonsArr, lThicknessCm, maxNoOfLayers)) {
      logger(MSG.ERROR, 'Error fetching soil data.');
      return;
    }
    
    logger(MSG.INFO, 'Fetched soil data.');

    /* weather */
    var da = new DataAccessor(new Date(startYear, 0, 1), new Date(endYear, 11, 31));
    if (!createClimate(da, cpp, sp.vs_Latitude)) {
      logger(MSG.ERROR, 'Error fetching climate data.');
      return;
    }
    
    logger(MSG.INFO, 'Fetched climate data.');

    /* crops */
    var pps = [];
    if (!createProcesses(pps, cropsArr)) {
      logger(MSG.ERROR, 'Error fetching crop data.');
      return;
    }
    
    logger(MSG.INFO, 'Fetched crop data.');

    var env = new Environment(layers, cpp);
    env.general = gp;
    env.pathToOutputDir = _outPath;
    // env.setMode(1); // JS! not implemented
    env.site = sp;
    env.da = da;
    env.cropRotation = pps;

    logger(MSG.INFO, 'Start monica model.');

    return runMonica(env, setProgress);
  };


  var createLayers = function createLayers(layers, horizonsArr, lThicknessCm, maxNoOfLayers) {

    var ok = true;
    var hs = horizonsArr.length;
    var depth = 0;
    
    logger(MSG.INFO, 'Fetching ' + hs + ' horizons.');

    for (var h = 0; h < hs; ++h ) {

      debug('lThicknessCm', lThicknessCm);
      debug('maxNoOfLayers', maxNoOfLayers);
      debug('depth', depth);
      
      var horizonObj = horizonsArr[h];

      // var hLoBoundaryCm = 100 * horizonObj.lowerBoundary;
      // var hUpBoundaryCm = layers.length * lThicknessCm;
      // var hThicknessCm = max(0, hLoBoundaryCm - hUpBoundaryCm);
      var hThicknessCm = horizonObj.thickness * 100;
      var lInHCount = int(round(hThicknessCm / lThicknessCm));

      /* fill all (maxNoOfLayers) layers if available horizons depth < lThicknessCm * maxNoOfLayers */
      if (h == (hs - 1) && (int(layers.length) + lInHCount) < maxNoOfLayers)
        lInHCount += maxNoOfLayers - layers.length - lInHCount;

      for (var l = 0; l < lInHCount; l++) {

        /* stop if we reach max. depth */
        if (depth === maxNoOfLayers * lThicknessCm) {
          logger(MSG.WARN, 'Maximum soil layer depth (' + (maxNoOfLayers * lThicknessCm) + ' cm) reached. Remaining layers in horizon ' + h + ' ignored.');
          break;
        }

        depth += lThicknessCm;

        var layer = new SoilParameters();
        layer.set_vs_SoilOrganicCarbon(horizonObj.Corg);
        if (horizonObj.bulkDensity)
          layer.set_vs_SoilBulkDensity(horizonObj.bulkDensity);
        layer.vs_SoilSandContent = horizonObj.sand;
        layer.vs_SoilClayContent = horizonObj.clay;
        layer.vs_SoilStoneContent = horizonObj.sceleton; //TODO: / 100 ?
        layer.vs_Lambda = Tools.texture2lambda(layer.vs_SoilSandContent, layer.vs_SoilClayContent);
        // TODO: Wo wird textureClass verwendet?
        layer.vs_SoilTexture = horizonObj.textureClass;
        layer.vs_SoilpH = horizonObj.pH;
        /* TODO: ? lambda = drainage_coeff ? */
        layer.vs_Lambda = Tools.texture2lambda(layer.vs_SoilSandContent, layer.vs_SoilClayContent);
        layer.vs_FieldCapacity = horizonObj.fieldCapacity;
        /* TODO: name? */
        layer.vs_Saturation = horizonObj.poreVolume;
        layer.vs_PermanentWiltingPoint = horizonObj.permanentWiltingPoint;

        /* TODO: hinter readJSON verschieben */ 
        if (!layer.isValid()) {
          ok = false;
          logger(MSG.ERROR, 'Error in soil parameters.');
        }

        layers.push(layer);
        logger(MSG.INFO, 'Fetched layer ' + layers.length + ' in horizon ' + h + '.');

      }

      logger(MSG.INFO, 'Fetched horizon ' + h + '.');
    }  

    return ok;
  };

  function createProcesses(pps, cropsArr) {
    
    var ok = true;
    var cs = cropsArr.length;
    
    logger(MSG.INFO, 'Fetching ' + cs + ' crops.');

    for (var c = 0; c < cs; c++) {

      var cropObj = cropsArr[c];
      var cropId = cropObj.name.id;

      // var nameAndGenType = cropObj.nameAndGenType;

      // var res = db.exec(
      //  "SELECT crop_id \
      //   FROM view_crop \
      //   WHERE name_and_gentype='" + nameAndGenType + "'"
      // );

      // if (res.length > 0)
      //   cropId = res[0].values[0][0];

      if (!cropId || cropId < 0 || isNaN(cropId)) {
        ok = false;
        logger(MSG.ERROR, 'Invalid crop id: ' + cropId + '.');
      }

      var sd = new Date(Date.parse(cropObj.sowingDate));
      var hd = new Date(Date.parse(cropObj.finalHarvestDate));

      debug(sd, 'sd');
      debug(hd, 'hd');

      if (!sd.isValid() || !hd.isValid()) {
        ok = false;
        logger(MSG.ERROR, 'Invalid sowing or harvest date.');
      }

      var crop = new Crop(cropId, cropObj.name.name + ', ' + cropObj.name.gen_type /*TODO: hermesCropId?*/);
      crop.setSeedAndHarvestDate(sd, hd);
      crop.setCropParameters(getCropParameters(crop.id()));
      crop.setResidueParameters(getResidueParameters(crop.id()));

      pps[c] = new ProductionProcess(cropObj.name.name + ', ' + cropObj.name.gen_type, crop);

      /* tillage */
      var tillArr = cropObj.tillageOperations;
      if (tillArr) { /* in case no tillage has been added */
        if (!addTillageOperations(pps[c], tillArr)) {
          ok = false;
          logger(MSG.ERROR, 'Error adding tillages.');
        }
      }

      /* mineral fertilizer */
      var minFertArr = cropObj.mineralFertilisers;
      if (minFertArr) { /* in case no min fertilizer has been added */
        if (!addFertilizers(pps[c], minFertArr, false)) {
          ok = false;
          logger(MSG.ERROR, 'Error adding mineral fertilisers.');
        }
      }

      /* organic fertilizer */ 
      var orgFertArr = cropObj.organicFertilisers;
      if (orgFertArr) { /* in case no org fertilizer has been added */ 
        if (!addFertilizers(pps[c], orgFertArr, true)) {
          ok = false;
          logger(MSG.ERROR, 'Error adding organic fertilisers.');
        }
      }

      /* irrigations */
      var irriArr = cropObj.irrigations;
      if (irriArr) {  /* in case no irrigation has been added */
        if (!addIrrigations(pps[c], irriArr)) {
          ok = false;
          logger(MSG.ERROR, 'Error adding irrigations.');
        }
      }

      /* cutting */
      var cutArr = cropObj.cuttings;
      if (cutArr) { /* in case no tillage has been added */
        if (!addCuttings(pps[c], cutArr)) {
          ok = false;
          logger(MSG.ERROR, 'Error adding cuttings.');
        }
      }

      logger(MSG.INFO, 'Fetched crop ' + c + ', name: ' + cropObj.name.name + ', id: ' + cropId + '.');

    }

    return ok;
  };

  function addTillageOperations(pp, tillArr) {

    var ok = true;
    var ts = tillArr.length;

    logger(MSG.INFO, 'Fetching ' + ts + ' tillages.');

    for (var t = 0; t < ts; ++t) {

      var tillObj = tillArr[t];

      /* ignore if any value is null */
      if (tillObj.date === null || tillObj.depth === null || tillObj.method === null) {
        logger(MSG.WARN, 'At least one tillage parameter null: tillage ' + t + ' ignored.');
        continue;
      }

      var tDate = new Date(Date.parse(tillObj.date));
      var depth = tillObj.depth / 100; // cm to m
      var method = tillObj.method;

      if (!tDate.isValid()) {
        ok = false;
        logger(MSG.ERROR, 'Invalid tillage date in tillage no. ' + t + '.');
      }

      pp.addApplication(new TillageApplication(tDate, depth));

      logger(MSG.INFO, 'Fetched tillage ' + t + '.');

    }

    return ok;
  };

  function addFertilizers(pp, fertArr, isOrganic) {
    // TODO: implement in JS
    /*
    //get data parsed and to use leap years if the crop rotation uses them
    Date fDateate = parseDate(sfDateate).toDate(it->crop()->seedDate().useLeapYears());

    if (!fDateate.isValid())
    {
      debug() << 'Error - Invalid date in \'' << pathToFile << '\'' << endl;
      debug() << 'Line: ' << s << endl;
      ok = false;
    }

   //if the currently read fertiliser date is after the current end
    //of the crop, move as long through the crop rotation as
    //we find an end date that lies after the currently read fertiliser date
    while (fDateate > currentEnd)
    {
      //move to next crop and possibly exit at the end
      it++;
      if (it == cr.end())
        break;

      currentEnd = it->end();

      //cout << 'new PP start: ' << it->start().toString()
      //<< ' new PP end: ' << it->end().toString() << endl;
      //cout << 'new currentEnd: ' << currentEnd.toString() << endl;
    }
    */
    var ok = true;
    var fs = fertArr.length;

    logger(MSG.INFO, 'Fetching ' + fs + ' ' + (isOrganic ? 'organic' : 'mineral') + ' fertilisers.');

    for (var f = 0; f < fs; ++f) {
      
      var fertObj = fertArr[f];

      /* ignore if any value is null */
      if (fertObj.date === null || fertObj.method === null || fertObj.type === null || fertObj.amount === null) {
        logger(MSG.WARN, 'At least one fertiliser parameter null: ' + (isOrganic ? 'organic' : 'mineral') + ' fertiliser ' + f + 'ignored.');
        continue;
      }

      var fDate = new Date(Date.parse(fertObj.date));
      var method = fertObj.method;
      var type = fertObj.type;
      var amount = fertObj.amount;
      var min = fertObj.min;
      var max = fertObj.max;
      var delayInDays = fertObj.delayInDays;

      if (!fDate.isValid()) {
        ok = false;
        logger(MSG.ERROR, 'Invalid fertilization date in ' + f + '.');
      }

      if (method == "Automated"){
        pp.crop().setUseNMinMethod(true);
        logger(MSG.INFO, "Using NMin method for fertilizing crop " + pp.crop().name());
      }

      if (isOrganic)  {

        var orgId = type.id;

        // var res = db.exec(
        //  "SELECT id \
        //   FROM organic_fertiliser \
        //   WHERE om_type='" + type + "'"
        // );

        // if (res.length > 0)
        //   orgId = res[0].values[0][0]; 
    
        if (orgId < 0) {
          logger(MSG.ERROR, 'Organic fertilser ' + type.id + ' not found.');
          ok = false;
        }

        pp.addApplication(new OrganicFertiliserApplication(fDate, getOrganicFertiliserParameters(orgId), amount, true));
      
      } else { // not organic

        var minId = type.id;

        // var res = db.exec(
        //  "SELECT id \
        //   FROM mineral_fertilisers \
        //   WHERE name='" + type + "'"
        // );
 
        // if (res.length > 0)
        //   minId = res[0].values[0][0]; 
        
        if (minId < 0) {
          logger(MSG.ERROR, 'Mineral fertilser ' + type.id + ' not found.');
          ok = false;
        }
        
        if(method == "Automated"){
          pp.crop().setNMinFertiliserPartition(getMineralFertiliserParameters(minId));
          pp.crop().setNMinUserParams(new NMinUserParameters(min, max, delayInDays));
        } else {
          pp.addApplication(new MineralFertiliserApplication(fDate, getMineralFertiliserParameters(minId), amount));
        }
      
      }

      logger(MSG.INFO, 'Fetched ' + (isOrganic ? 'organic' : 'mineral') + ' fertiliser ' + f + '.');

    }
     
    return ok;
    
  };


  function addIrrigations(pp, irriArr) {
    
    var ok = true;

    // TODO: implement in JS
    //get data parsed and to use leap years if the crop rotation uses them
    /*Date idate = parseDate(irrDate).toDate(it->crop()->seedDate().useLeapYears());
    if (!idate.isValid())
    {
      debug() << 'Error - Invalid date in \'' << pathToFile << '\'' << endl;
      debug() << 'Line: ' << s << endl;
      debug() << 'Aborting simulation now!' << endl;
      exit(-1);
    }

    //cout << 'PP start: ' << it->start().toString()
    //<< ' PP end: ' << it->end().toString() << endl;
    //cout << 'irrigationDate: ' << idate.toString()
    //<< ' currentEnd: ' << currentEnd.toString() << endl;

    //if the currently read irrigation date is after the current end
    //of the crop, move as long through the crop rotation as
    //we find an end date that lies after the currently read irrigation date
    while (idate > currentEnd)
    {
      //move to next crop and possibly exit at the end
      it++;
      if (it == cr.end())
        break;

      currentEnd = it->end();

      //cout << 'new PP start: ' << it->start().toString()
      //<< ' new PP end: ' << it->end().toString() << endl;
      //cout << 'new currentEnd: ' << currentEnd.toString() << endl;
    }*/

    var is = irriArr.length;
    
    logger(MSG.INFO, 'Fetching ' + is + ' irrigations.');

    for (var i = 0; i < is; ++i) {
      
      var irriObj = irriArr[i];

      /* ignore if any value is null */
      if (irriObj.date === null || irriObj.method  === null || irriObj.eventType  === null || irriObj.threshold  === null
          || irriObj.amount === null || irriObj.NConc === null) {
        logger(MSG.WARN, 'At least one irrigation parameter null: irrigation ' + i + ' ignored.');
        continue;
      }

      var method = irriObj.method;
      var eventType = irriObj.eventType;
      var threshold = irriObj.threshold;
      var area = irriObj.area;
      var amount = irriObj.amount;
      var NConc = irriObj.NConc;
      var iDate = new Date(Date.parse(irriObj.date));

      if (!iDate.isValid()) {
        ok = false;
        logger(MSG.ERROR, 'Invalid irrigation date in ' + i + '.');
      }

      if (eventType == "Content"){
        pp.crop().setUseAutomaticIrrigation(true);
        pp.crop().setAutoIrrigationParams(new AutomaticIrrigationParameters(amount, threshold, NConc, 0));
        logger(MSG.INFO, "Using automatic irrigation for crop " + pp.crop().name());
      } else {
        pp.addApplication(new IrrigationApplication(iDate, amount, new IrrigationParameters(NConc, 0.0)));
      }

      logger(MSG.INFO, 'Fetched irrigation ' + i + '.');

    }

    return ok;
  };

  /*
    JV: test new function
  */

  function addCuttings(pp, cutArr) {

    var ok = true;
    var cs = cutArr.length;

    logger(MSG.INFO, 'Fetching ' + cs + ' cuttings.');

    for (var c = 0; c < cs; ++c) {
      var cutObj = cutArr[c];
      var cDate = new Date(Date.parse(cutObj.date));
      pp.addApplication(new Cutting(cDate, pp.crop(), pp.cropResult()));
    }

    return ok;
  };


  function createClimate(da, cpp, latitude, useLeapYears) {

    var ok = false;

    if (climate) {

      da.addClimateData(Climate.tmin, new Float64Array(climate.tmin));
      da.addClimateData(Climate.tmax, new Float64Array(climate.tmax));
      da.addClimateData(Climate.tavg, new Float64Array(climate.tavg));
      da.addClimateData(Climate.globrad, new Float64Array(climate.globrad)); /* MJ m-2 */
      da.addClimateData(Climate.wind, new Float64Array(climate.wind));
      da.addClimateData(Climate.precip, new Float64Array(climate.precip));

      if(climate.sunhours.length > 0)
        da.addClimateData(Climate.sunhours, new Float64Array(climate.sunhours));

      if (climate.relhumid.length > 0)
        da.addClimateData(Climate.relhumid, new Float64Array(climate.relhumid));

      /* TODO: add additional checks */
      ok = true;
    }

    return ok;

    /* we dont use hermes MET files anymore */
    // var tmin = [];
    // var tavg = [];
    // var tmax = [];
    // var globrad = [];
    // var relhumid = [];
    // var wind = [];
    // var precip = [];
    // var sunhours = [];

    // var date = new Date(da.startDate().getFullYear(), 0, 1);

    // var idx_t_av = data.met.columns.indexOf('t_av');
    // var idx_t_min = data.met.columns.indexOf('t_min');
    // var idx_t_max = data.met.columns.indexOf('t_max');
    // var idx_t_s10 = data.met.columns.indexOf('t_s10');
    // var idx_t_s20 = data.met.columns.indexOf('t_s20');
    // var idx_vappd = data.met.columns.indexOf('vappd');
    // var idx_wind = data.met.columns.indexOf('wind');
    // var idx_sundu = data.met.columns.indexOf('sundu');
    // var idx_radia = data.met.columns.indexOf('radia');
    // var idx_prec = data.met.columns.indexOf('prec');
    // var idx_day = data.met.columns.indexOf('day');
    // var idx_year = data.met.columns.indexOf('year');
    // var idx_rf = data.met.columns.indexOf('rf');

    // for (var y = da.startDate().getFullYear(), ys = da.endDate().getFullYear(); y <= ys; y++) {

    //   var daysCount = 0;
    //   var allowedDays = ceil((new Date(y + 1, 0, 1) - new Date(y, 0, 1)) / (24 * 60 * 60 * 1000));

    //   console.log('allowedDays: ' + allowedDays + ' ' + y+ '\t' + useLeapYears + '\tlatitude:\t' + latitude);

    //   for (var r = 0, rs = data.met.rows.length; r < rs; r++) {

    //     var row = data.met.rows[r];
    //     if (row[idx_year] != y)
    //       continue;

    //     if (row[idx_radia] >= 0) {
    //       // use globrad
    //       // HERMES weather files deliver global radiation as [J cm-2]
    //       // Here, we push back [MJ m-2 d-1]
    //       var globradMJpm2pd = row[idx_radia] * 100.0 * 100.0 / 1000000.0;
    //       globrad.push(globradMJpm2pd);        
    //     } else if (row[idx_sundu] >= 0.0) {
    //       // invalid globrad use sunhours
    //       // convert sunhours into globrad
    //       // debug() << 'Invalid globrad - use sunhours instead' << endl;
    //       globrad.push(Tools.sunshine2globalRadiation(r + 1, sunhours, latitude, true));    
    //       sunhours.push(row[idx_sundu]);
    //     } else {
    //       // error case
    //       console.log('Error: No global radiation or sunhours specified for day ' + date);
    //       ok = false;
    //     }

    //     if (row[idx_rf] >= 0.0)
    //       relhumid.push(row[idx_rf]);

    //     tavg.push(row[idx_t_av]);
    //     tmin.push(row[idx_t_min]);
    //     tmax.push(row[idx_t_max]);
    //     wind.push(row[idx_wind]);
    //     precip.push(row[idx_prec]);

    //     daysCount++;
    //     date = new Date(date.getFullYear, date.getMonth(), date.getDate() + 1);
    //   }
    // }

    // da.addClimateData(Climate.tmin, new Float64Array(tmin));
    // da.addClimateData(Climate.tmax, new Float64Array(tmax));
    // da.addClimateData(Climate.tavg, new Float64Array(tavg));
    // da.addClimateData(Climate.globrad, new Float64Array(globrad));
    // da.addClimateData(Climate.wind, new Float64Array(wind));
    // da.addClimateData(Climate.precip, new Float64Array(precip));

    // if(sunhours.length > 0)
    //   da.addClimateData(Climate.sunhours, new Float64Array(sunhours));

    // if (relhumid.length > 0)
    //   da.addClimateData(Climate.relhumid, new Float64Array(relhumid));

    // return ok;

  };

  var setProgress = function (date, model) {

    var progress = {};

    /* if both null we are done */
    if (!date && !model) {
      progress = null;
    } else {

      var isCropPlanted = model.isCropPlanted()
        , mcg = model.cropGrowth()
        , mst = model.soilTemperature()
        , msm = model.soilMoisture()
        , mso = model.soilOrganic()
        , msc = model.soilColumn()
        /* TODO: (from cpp) work-around. Hier muss was eleganteres hin! */
        , msa = model.soilColumnNC()
        , msq = model.soilTransport()
        ;

      progress = {
          date: { value: date.toISOString(), unit: '[date]' }
        , CropName: { value: isCropPlanted ? mcg.get_CropName() : '', unit: '-' }
        , TranspirationDeficit: { value: isCropPlanted ? mcg.get_TranspirationDeficit() : 0, unit: '[0;1]' }
        , ActualTranspiration: { value: isCropPlanted ? mcg.get_ActualTranspiration() : 0, unit: '[mm]' } 
        , CropNRedux: { value: isCropPlanted ? mcg.get_CropNRedux() : 0, unit: '[0;1]' }
        , HeatStressRedux: { value: isCropPlanted ? mcg.get_HeatStressRedux() : 0, unit: '[0;1]' }
        , OxygenDeficit: { value: isCropPlanted ? mcg.get_OxygenDeficit() : 0, unit: '[0;1]' }
        , DevelopmentalStage: { value: isCropPlanted ? mcg.get_DevelopmentalStage() + 1 : 0, unit: '[#]' }
        , CurrentTemperatureSum: { value: isCropPlanted ? mcg.get_CurrentTemperatureSum() : 0, unit: '°C' }
        , VernalisationFactor: { value: isCropPlanted ? mcg.get_VernalisationFactor() : 0, unit: '[0;1]' }
        , DaylengthFactor: { value: isCropPlanted ? mcg.get_DaylengthFactor() : 0, unit: '[0;1]' }
        , OrganGrowthIncrementRoot: { value: isCropPlanted ? mcg.get_OrganGrowthIncrement(0) : 0, unit: '[kg (DM) ha-1]' }
        , OrganGrowthIncrementLeaf: { value: isCropPlanted ? mcg.get_OrganGrowthIncrement(1) : 0, unit: '[kg (DM) ha-1]' }
        , OrganGrowthIncrementShoot: { value: isCropPlanted ? mcg.get_OrganGrowthIncrement(2) : 0, unit: '[kg (DM) ha-1]' }
        , OrganGrowthIncrementFruit: { value: isCropPlanted ? mcg.get_OrganGrowthIncrement(3) : 0, unit: '[kg (DM) ha-1]' }
        , RelativeTotalDevelopment: { value: isCropPlanted ? mcg.get_RelativeTotalDevelopment() : 0, unit: '[0;1]' }
        , OrganBiomassRoot: { value: isCropPlanted ? mcg.get_OrganBiomass(0) : 0, unit: '[kg (DM) ha-1]' }
        , OrganBiomassLeaf: { value: isCropPlanted ? mcg.get_OrganBiomass(1) : 0, unit: '[kg (DM) ha-1]' }
        , OrganBiomassShoot: { value: isCropPlanted ? mcg.get_OrganBiomass(2) : 0, unit: '[kg (DM) ha-1]' }
        , OrganBiomassFruit: { value: isCropPlanted ? mcg.get_OrganBiomass(3) : 0, unit: '[kg (DM) ha-1]' }
        , PrimaryCropYield: { value: isCropPlanted ? mcg.get_PrimaryCropYield() : 0, unit: '[kg (DM) ha-1]' }
        , LeafAreaIndex: { value:  isCropPlanted ? mcg.get_LeafAreaIndex() : 0, unit: '[m-2 m-2]' }
        , GrossPhotosynthesisHaRate: { value: isCropPlanted ? mcg.get_GrossPhotosynthesisHaRate() : 0, unit: '[kg (CH2O) ha-1 d-1]' }
        , NetPhotosynthesis: { value: isCropPlanted ? mcg.get_NetPhotosynthesis() : 0, unit: '[kg (CH2O) ha-1 d-1]' }
        , MaintenanceRespirationAS: { value: isCropPlanted ? mcg.get_MaintenanceRespirationAS() : 0, unit: '[kg (CH2O) ha-1 d-1]' }
        , GrowthRespirationAS: { value: isCropPlanted ? mcg.get_GrowthRespirationAS() : 0, unit: '[kg (CH2O) ha-1 d-1]' }
        , StomataResistance: { value: isCropPlanted ? mcg.get_StomataResistance() : 0, unit: '[s m-1]' }
        , CropHeight: { value: isCropPlanted ? mcg.get_CropHeight() : 0, unit: '[m]' }
        , LeafAreaIndex: { value: isCropPlanted ? mcg.get_LeafAreaIndex() : 0, unit: '[m2 m-2]' }
        , RootingDepth: { value: isCropPlanted ? mcg.get_RootingDepth() : 0, unit: '[layer #]' }
        , AbovegroundBiomass: { value: isCropPlanted ? mcg.get_AbovegroundBiomass() : 0, unit: '[kg ha-1]' }
        , TotalBiomassNContent: { value: isCropPlanted ? mcg.get_TotalBiomassNContent() : 0, unit: '[?]' }
        , SumTotalNUptake: { value: isCropPlanted ? mcg.get_SumTotalNUptake() : 0, unit: '[kg (N) ha-1]' }
        , ActNUptake: { value: isCropPlanted ? mcg.get_ActNUptake() : 0, unit: '[kg (N) ha-1]' }
        , PotNUptake: { value: isCropPlanted ? mcg.get_PotNUptake() : 0, unit: '[kg (N) ha-1]' }
        , TargetNConcentration: { value: isCropPlanted ? mcg.get_TargetNConcentration() : 0, unit: '[kg (N) ha-1]' }
        , CriticalNConcentration: { value: isCropPlanted ? mcg.get_CriticalNConcentration() : 0, unit: '[kg (N) ha-1]' }
        , AbovegroundBiomassNConcentration: { value: isCropPlanted ? mcg.get_AbovegroundBiomassNConcentration() : 0, unit: '[kg (N) ha-1]' }
        , NetPrimaryProduction: { value: isCropPlanted ? mcg.get_NetPrimaryProduction() : 0, unit: '[kg (N) ha-1]' }
        , GrossPrimaryProduction: { value: isCropPlanted ? mcg.get_GrossPrimaryProduction() : 0, unit: '[kg (N) ha-1]' }
        , AutotrophicRespiration: { value: isCropPlanted ? mcg.get_AutotrophicRespiration() : 0, unit: '[kg (C) ha-1]' }
      };

      var outLayers = 20;

      for (var i_Layer = 0; i_Layer < outLayers; i_Layer++)
        progress['SoilMoisture_' + i_Layer] = { value: msm.get_SoilMoisture(i_Layer), unit: '[m-3 m-3]' };

      progress['dailySumIrrigationWater'] = { value: model.dailySumIrrigationWater(), unit: '[mm]' };
      progress['Infiltration'] = { value: msm.get_Infiltration(), unit: '[mm]' };
      progress['SurfaceWaterStorage'] = { value: msm.get_SurfaceWaterStorage(), unit: '[mm]' };
      progress['SurfaceRunOff'] = { value: msm.get_SurfaceRunOff(), unit: '[mm]' };
      progress['SnowDepth'] = { value: msm.get_SnowDepth(), unit: '[mm]' }; 
      progress['FrostDepth'] = { value: msm.get_FrostDepth(), unit: '[mm]' };
      progress['ThawDepth'] = { value: msm.get_ThawDepth(), unit: '[mm]' };

      for (var i_Layer = 0; i_Layer < outLayers; i_Layer++)
       progress['PASW_' + i_Layer] = { value: msm.get_SoilMoisture(i_Layer) - msa[i_Layer].get_PermanentWiltingPoint(), unit: '[m-3 m-3]' };

      progress['SoilSurfaceTemperature'] = { value: mst.get_SoilSurfaceTemperature(), unit: '[°C]' };

      for(var i_Layer = 0; i_Layer < 5; i_Layer++)
        progress['SoilTemperature_' + i_Layer] = { value: mst.get_SoilTemperature(i_Layer), unit: '[°C]' };

      progress['ActualEvaporation'] = { value: msm.get_ActualEvaporation(), unit: '[mm]' };
      progress['Evapotranspiration'] = { value: msm.get_Evapotranspiration(), unit: '[mm]' };
      progress['ET0'] = { value: msm.get_ET0(), unit: '[mm]' };
      progress['KcFactor'] = { value: msm.get_KcFactor(), unit: '[?]' };
      progress['AtmosphericCO2Concentration'] = { value: model.get_AtmosphericCO2Concentration(), unit: '[ppm]' };
      progress['GroundwaterDepth'] = { value: model.get_GroundwaterDepth(), unit: '[m]' };
      progress['GroundwaterRecharge'] = { value: msm.get_GroundwaterRecharge(), unit: '[mm]' };
      progress['NLeaching'] = { value: msq.get_NLeaching(), unit: '[kg (N) ha-1]' };

      for(var i_Layer = 0; i_Layer < outLayers; i_Layer++)
        progress['SoilNO3_' + i_Layer] = { value: msc.soilLayer(i_Layer).get_SoilNO3(), unit: '[kg (N) m-3]' };

      progress['SoilCarbamid'] = { value: msc.soilLayer(0).get_SoilCarbamid(), unit: '[kg (N) m-3]' };

      for(var i_Layer = 0; i_Layer < outLayers; i_Layer++)
        progress['SoilNH4_' + i_Layer] = { value: msc.soilLayer(i_Layer).get_SoilNH4(), unit: '[kg (N) m-3]' };

      for(var i_Layer = 0; i_Layer < 4; i_Layer++)
        progress['SoilNO2_' + i_Layer] = { value: msc.soilLayer(i_Layer).get_SoilNO2(), unit: '[kg (N) m-3]' };

      for(var i_Layer = 0; i_Layer < 6; i_Layer++)
        progress['SoilOrganicCarbon_' + i_Layer] = { value: msc.soilLayer(i_Layer).vs_SoilOrganicCarbon(), unit: '[kg (C) kg-1]' };

      for(var i_Layer = 0; i_Layer < 1; i_Layer++)
        progress['AOMf_' + i_Layer] = { value: mso.get_AOM_FastSum(i_Layer), unit: '[kg (C) m-3]' };

      for(var i_Layer = 0; i_Layer < 1; i_Layer++)
        progress['AOMs_' + i_Layer] = { value: mso.get_AOM_SlowSum(i_Layer), unit: '[kg (C) m-3]' };

      for(var i_Layer = 0; i_Layer < 1; i_Layer++)
        progress['SMBf_' + i_Layer] = { value: mso.get_SMB_Fast(i_Layer), unit: '[kg (C) m-3]' };

      for(var i_Layer = 0; i_Layer < 1; i_Layer++)
        progress['SMBs_' + i_Layer] = { value: mso.get_SMB_Slow(i_Layer), unit: '[kg (C) m-3]' };

      for(var i_Layer = 0; i_Layer < 1; i_Layer++)
        progress['SOMf_' + i_Layer] = { value: mso.get_SOM_Fast(i_Layer), unit: '[kg (C) m-3]' };

      for(var i_Layer = 0; i_Layer < 1; i_Layer++)
        progress['SOMs_' + i_Layer] = { value: mso.get_SOM_Slow(i_Layer), unit: '[kg (C) m-3]' };

      for(var i_Layer = 0; i_Layer < 3; i_Layer++)
        progress['Nmin_' + i_Layer] = { value: mso.get_NetNMineralisationRate(i_Layer), unit: '[kg (N) ha-1]' };

      progress['Denit'] = { value: mso.get_Denitrification(), unit: '[kg (N) ha-1]' };

      progress['N20'] = { value: mso.get_N2O_Produced(), unit: '[kg (N) ha-1]' };

      progress['NH3'] = { value: mso.get_NH3_Volatilised(), unit: '[kg (N) ha-1]' };

      progress['NFert'] = { value: model.dailySumFertiliser(), unit: '[kg (N) ha-1]' };

      progress["tmin"] = { value: model.dataAccessor().dataForTimestep(Climate.tmin, model.currentStepNo()), unit: "[°C]" };
    progress["tavg"] = { value: model.dataAccessor().dataForTimestep(Climate.tavg, model.currentStepNo()), unit: "[°C]" };
    progress["tmax"] = { value: model.dataAccessor().dataForTimestep(Climate.tmax, model.currentStepNo()), unit: "[°C]" };
    progress["precip"] = { value: model.dataAccessor().dataForTimestep(Climate.precip, model.currentStepNo()), unit: "[mm]" };
    progress["wind"] = { value: model.dataAccessor().dataForTimestep(Climate.wind, model.currentStepNo()), unit: "[m s-1]" };
    progress["globrad"] = { value: model.dataAccessor().dataForTimestep(Climate.globrad, model.currentStepNo()), unit: "[MJ m-2 d-1]" };
    progress["relhumid"] = { value: model.dataAccessor().dataForTimestep(Climate.relhumid, model.currentStepNo()), unit: "[m3 m-3]" };
    progress["sunhours"] = { value: model.dataAccessor().dataForTimestep(Climate.sunhours, model.currentStepNo()), unit: "[h]" };
    }
  
    if (ENVIRONMENT_IS_WORKER)
      postMessage({ progress: progress });
    else
      logger(MSG.INFO, (progress ? progress.date.value : 'done'));
  
  };  

  return {
    run: run 
  };


};
