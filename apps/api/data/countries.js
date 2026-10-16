// Centralized country and state data.
// Extracted from routes/countries.js to avoid duplication across server.js, routes/auth.js, and routes/countries.js.

// List of all countries in the world
const allCountries = [
    "Afghanistan", "Albania", "Algeria", "Andorra", "Angola", "Antigua and Barbuda", "Argentina", "Armenia", "Australia", "Austria",
    "Azerbaijan", "Bahamas", "Bahrain", "Bangladesh", "Barbados", "Belarus", "Belgium", "Belize", "Benin", "Bhutan", "Bolivia",
    "Bosnia and Herzegovina", "Botswana", "Brazil", "Brunei", "Bulgaria", "Burkina Faso", "Burundi", "Cambodia", "Cameroon",
    "Canada", "Cape Verde", "Central African Republic", "Chad", "Chile", "China", "Colombia", "Comoros", "Congo",
    "Costa Rica", "Croatia", "Cuba", "Cyprus", "Czech Republic", "Democratic Republic of the Congo", "Denmark", "Djibouti",
    "Dominica", "Dominican Republic", "Ecuador", "Egypt", "El Salvador", "Equatorial Guinea", "Eritrea", "Estonia", "Eswatini",
    "Ethiopia", "Fiji", "Finland", "France", "Gabon", "Gambia", "Georgia", "Germany", "Ghana", "Greece", "Grenada", "Guatemala",
    "Guinea", "Guinea-Bissau", "Guyana", "Haiti", "Honduras", "Hungary", "Iceland", "India", "Indonesia", "Iran", "Iraq",
    "Ireland", "Israel", "Italy", "Ivory Coast", "Jamaica", "Japan", "Jordan", "Kazakhstan", "Kenya", "Kiribati", "Kuwait",
    "Kyrgyzstan", "Laos", "Latvia", "Lebanon", "Lesotho", "Liberia", "Libya", "Liechtenstein", "Lithuania", "Luxembourg",
    "Madagascar", "Malawi", "Malaysia", "Maldives", "Mali", "Malta", "Marshall Islands", "Mauritania", "Mauritius", "Mexico",
    "Micronesia", "Moldova", "Monaco", "Mongolia", "Montenegro", "Morocco", "Mozambique", "Myanmar", "Namibia", "Nauru",
    "Nepal", "Netherlands", "New Zealand", "Nicaragua", "Niger", "Nigeria", "North Korea", "North Macedonia", "Norway",
    "Oman", "Pakistan", "Palau", "Palestine", "Panama", "Papua New Guinea", "Paraguay", "Peru", "Philippines", "Poland",
    "Portugal", "Qatar", "Romania", "Russia", "Rwanda", "Saint Kitts and Nevis", "Saint Lucia", "Samoa", "San Marino",
    "Sao Tome and Principe", "Saudi Arabia", "Senegal", "Serbia", "Seychelles", "Sierra Leone", "Singapore", "Slovakia",
    "Slovenia", "Solomon Islands", "Somalia", "South Africa", "South Korea", "South Sudan", "Spain", "Sri Lanka", "Sudan",
    "Suriname", "Sweden", "Switzerland", "Syria", "Taiwan", "Tajikistan", "Tanzania", "Thailand", "Timor-Leste", "Togo",
    "Tonga", "Trinidad and Tobago", "Tunisia", "Turkey", "Turkmenistan", "Tuvalu", "Uganda", "Ukraine",
    "United Arab Emirates", "United Kingdom", "United States", "Uruguay", "Uzbekistan", "Vanuatu", "Vatican City",
    "Venezuela", "Vietnam", "Yemen", "Zambia", "Zimbabwe"
];

// Function to get states/provinces/regions for a country
async function getStates(country) {
    // Object containing states/provinces/regions for common countries
    const countryStates = {
        "United States": [
            "Alabama", "Alaska", "Arizona", "Arkansas", "California", "Colorado", "Connecticut", "Delaware", "Florida", "Georgia",
            "Hawaii", "Idaho", "Illinois", "Indiana", "Iowa", "Kansas", "Kentucky", "Louisiana", "Maine", "Maryland",
            "Massachusetts", "Michigan", "Minnesota", "Mississippi", "Missouri", "Montana", "Nebraska", "Nevada", "New Hampshire", "New Jersey",
            "New Mexico", "New York", "North Carolina", "North Dakota", "Ohio", "Oklahoma", "Oregon", "Pennsylvania", "Rhode Island", "South Carolina",
            "South Dakota", "Tennessee", "Texas", "Utah", "Vermont", "Virginia", "Washington", "West Virginia", "Wisconsin", "Wyoming"
        ],
        "Canada": [
            "Alberta", "British Columbia", "Manitoba", "New Brunswick", "Newfoundland and Labrador", "Northwest Territories",
            "Nova Scotia", "Nunavut", "Ontario", "Prince Edward Island", "Quebec", "Saskatchewan", "Yukon"
        ],
        "Mexico": [
            "Aguascalientes", "Baja California", "Baja California Sur", "Campeche", "Chiapas", "Chihuahua", "Coahuila",
            "Colima", "Durango", "Guanajuato", "Guerrero", "Hidalgo", "Jalisco", "MÃ©xico", "MichoacÃ¡n", "Morelos",
            "Nayarit", "Nuevo LeÃ³n", "Oaxaca", "Puebla", "QuerÃ©taro", "Quintana Roo", "San Luis PotosÃ­", "Sinaloa",
            "Sonora", "Tabasco", "Tamaulipas", "Tlaxcala", "Veracruz", "YucatÃ¡n", "Zacatecas"
        ],
        "United Kingdom": [
            "England", "Scotland", "Wales", "Northern Ireland"
        ],
        "Australia": [
            "New South Wales", "Victoria", "Queensland", "Western Australia", "South Australia",
            "Tasmania", "Australian Capital Territory", "Northern Territory"
        ],
        "India": [
            "Andhra Pradesh", "Arunachal Pradesh", "Assam", "Bihar", "Chhattisgarh", "Goa", "Gujarat", "Haryana",
            "Himachal Pradesh", "Jharkhand", "Karnataka", "Kerala", "Madhya Pradesh", "Maharashtra", "Manipur",
            "Meghalaya", "Mizoram", "Nagaland", "Odisha", "Punjab", "Rajasthan", "Sikkim", "Tamil Nadu",
            "Telangana", "Tripura", "Uttar Pradesh", "Uttarakhand", "West Bengal"
        ],
        "China": [
            "Anhui", "Fujian", "Gansu", "Guangdong", "Guizhou", "Hainan", "Hebei", "Heilongjiang", "Henan",
            "Hubei", "Hunan", "Jiangsu", "Jiangxi", "Jilin", "Liaoning", "Qinghai", "Shaanxi", "Shandong",
            "Shanxi", "Sichuan", "Yunnan", "Zhejiang", "Guangxi", "Inner Mongolia", "Ningxia", "Xinjiang", "Tibet"
        ],
        "Brazil": [
            "Acre", "Alagoas", "AmapÃ¡", "Amazonas", "Bahia", "CearÃ¡", "Distrito Federal", "EspÃ­rito Santo",
            "GoiÃ¡s", "MaranhÃ£o", "Mato Grosso", "Mato Grosso do Sul", "Minas Gerais", "ParÃ¡", "ParaÃ­ba",
            "ParanÃ¡", "Pernambuco", "PiauÃ­", "Rio de Janeiro", "Rio Grande do Norte", "Rio Grande do Sul",
            "RondÃ´nia", "Roraima", "Santa Catarina", "SÃ£o Paulo", "Sergipe", "Tocantins"
        ],
        "Germany": [
            "Baden-WÃ¼rttemberg", "Bavaria", "Berlin", "Brandenburg", "Bremen", "Hamburg", "Hesse",
            "Lower Saxony", "Mecklenburg-Vorpommern", "North Rhine-Westphalia", "Rhineland-Palatinate",
            "Saarland", "Saxony", "Saxony-Anhalt", "Schleswig-Holstein", "Thuringia"
        ],
        "Japan": [
            "Hokkaido", "Aomori", "Iwate", "Miyagi", "Akita", "Yamagata", "Fukushima",
            "Ibaraki", "Tochigi", "Gunma", "Saitama", "Chiba", "Tokyo", "Kanagawa",
            "Niigata", "Toyama", "Ishikawa", "Fukui", "Yamanashi", "Nagano", "Gifu",
            "Shizuoka", "Aichi", "Mie", "Shiga", "Kyoto", "Osaka", "Hyogo",
            "Nara", "Wakayama", "Tottori", "Shimane", "Okayama", "Hiroshima", "Yamaguchi",
            "Tokushima", "Kagawa", "Ehime", "Kochi", "Fukuoka", "Saga", "Nagasaki",
            "Kumamoto", "Oita", "Miyazaki", "Kagoshima", "Okinawa"
        ],
        "Ukraine": [
            "Vinnytsia", "Volyn", "Dnipropetrovsk", "Donetsk", "Zhytomyr", "Zakarpattia", 
            "Zaporizhzhia", "Ivano-Frankivsk", "Kyiv", "Kirovohrad", "Luhansk", "Lviv",
            "Mykolaiv", "Odesa", "Poltava", "Rivne", "Sumy", "Ternopil", "Kharkiv",
            "Kherson", "Khmelnytskyi", "Cherkasy", "Chernivtsi", "Chernihiv",
            "Autonomous Republic of Crimea", "Kyiv City", "Sevastopol City"
        ],
        "France": [
            "Auvergne-RhÃ´ne-Alpes", "Bourgogne-Franche-ComtÃ©", "Brittany", "Centre-Val de Loire",
            "Corsica", "Grand Est", "Hauts-de-France", "ÃŽle-de-France", "Normandy",
            "Nouvelle-Aquitaine", "Occitanie", "Pays de la Loire", "Provence-Alpes-CÃ´te d'Azur"
        ],
        "Italy": [
            "Abruzzo", "Basilicata", "Calabria", "Campania", "Emilia-Romagna",
            "Friuli Venezia Giulia", "Lazio", "Liguria", "Lombardy", "Marche",
            "Molise", "Piedmont", "Puglia", "Sardinia", "Sicily", "Tuscany",
            "Trentino-Alto Adige", "Umbria", "Valle d'Aosta", "Veneto"
        ],
        "Spain": [
            "Andalusia", "Aragon", "Asturias", "Balearic Islands", "Basque Country",
            "Canary Islands", "Cantabria", "Castile and LeÃ³n", "Castilla-La Mancha",
            "Catalonia", "Extremadura", "Galicia", "La Rioja", "Madrid",
            "Murcia", "Navarre", "Valencia", "Ceuta", "Melilla"
        ],
        "Poland": [
            "Greater Poland", "Kuyavian-Pomeranian", "Lesser Poland", "Lodz", "Lower Silesian",
            "Lublin", "Lubusz", "Masovian", "Opole", "Podkarpackie", "Podlaskie", "Pomeranian",
            "Silesian", "Swietokrzyskie", "Warmian-Masurian", "West Pomeranian"
        ],
        "Netherlands": [
            "Drenthe", "Flevoland", "Friesland", "Gelderland", "Groningen", "Limburg",
            "North Brabant", "North Holland", "Overijssel", "South Holland", "Utrecht", "Zeeland"
        ],
        "Belgium": [
            "Brussels-Capital Region", "Flanders", "Wallonia", "Antwerp", "East Flanders",
            "Flemish Brabant", "Hainaut", "LiÃ¨ge", "Limburg", "Luxembourg", "Namur",
            "Walloon Brabant", "West Flanders"
        ],
        "Sweden": [
            "Blekinge", "Dalarna", "GÃ¤vleborg", "Gotland", "Halland", "JÃ¤mtland",
            "JÃ¶nkÃ¶ping", "Kalmar", "Kronoberg", "Norrbotten", "Ã–rebro", "Ã–stergÃ¶tland",
            "SkÃ¥ne", "SÃ¶dermanland", "Stockholm", "Uppsala", "VÃ¤rmland", "VÃ¤sterbotten",
            "VÃ¤sternorrland", "VÃ¤stmanland", "VÃ¤stra GÃ¶taland"
        ],
        "Norway": [
            "Agder", "Innlandet", "MÃ¸re og Romsdal", "Nordland", "Oslo", "Rogaland",
            "Troms og Finnmark", "TrÃ¸ndelag", "Vestfold og Telemark", "Vestland", "Viken"
        ],
        "Russia": [
            "Adygea", "Altai Republic", "Bashkortostan", "Buryatia", "Dagestan", "Ingushetia", "Kabardino-Balkaria",
            "Kalmykia", "Karachay-Cherkessia", "Karelia", "Komi", "Mari El", "Mordovia", "North Ossetia-Alania",
            "Sakha (Yakutia)", "Tatarstan", "Tuva", "Udmurtia", "Khakassia", "Chechnya", "Chuvashia",
            "Altai Krai", "Krasnodar Krai", "Krasnoyarsk Krai", "Primorsky Krai", "Stavropol Krai", "Khabarovsk Krai",
            "Amur Oblast", "Arkhangelsk Oblast", "Astrakhan Oblast", "Belgorod Oblast", "Bryansk Oblast",
            "Vladimir Oblast", "Volgograd Oblast", "Vologda Oblast", "Voronezh Oblast", "Ivanovo Oblast",
            "Irkutsk Oblast", "Kaliningrad Oblast", "Kaluga Oblast", "Kamchatka Krai", "Kemerovo Oblast",
            "Kirov Oblast", "Kostroma Oblast", "Kurgan Oblast", "Kursk Oblast", "Leningrad Oblast",
            "Lipetsk Oblast", "Magadan Oblast", "Moscow Oblast", "Murmansk Oblast", "Nizhny Novgorod Oblast",
            "Novgorod Oblast", "Novosibirsk Oblast", "Omsk Oblast", "Orenburg Oblast", "Oryol Oblast",
            "Penza Oblast", "Perm Krai", "Pskov Oblast", "Rostov Oblast", "Ryazan Oblast", "Samara Oblast",
            "Saratov Oblast", "Sakhalin Oblast", "Sverdlovsk Oblast", "Smolensk Oblast", "Tambov Oblast",
            "Tver Oblast", "Tomsk Oblast", "Tula Oblast", "Tyumen Oblast", "Ulyanovsk Oblast", "Chelyabinsk Oblast",
            "Zabaykalsky Krai", "Yaroslavl Oblast", "Moscow", "Saint Petersburg", "Jewish Autonomous Oblast",
            "Nenets Autonomous Okrug", "Khanty-Mansi Autonomous Okrug", "Chukotka Autonomous Okrug",
            "Yamalo-Nenets Autonomous Okrug"
        ],
        "Turkey": [
            "Adana", "AdÄ±yaman", "Afyonkarahisar", "AÄŸrÄ±", "Amasya", "Ankara", "Antalya", "Artvin", "AydÄ±n",
            "BalÄ±kesir", "Bilecik", "BingÃ¶l", "Bitlis", "Bolu", "Burdur", "Bursa", "Ã‡anakkale", "Ã‡ankÄ±rÄ±",
            "Ã‡orum", "Denizli", "DiyarbakÄ±r", "Edirne", "ElazÄ±ÄŸ", "Erzincan", "Erzurum", "EskiÅŸehir",
            "Gaziantep", "Giresun", "GÃ¼mÃ¼ÅŸhane", "HakkÃ¢ri", "Hatay", "Isparta", "Mersin", "Ä°stanbul",
            "Ä°zmir", "Kars", "Kastamonu", "Kayseri", "KÄ±rklareli", "KÄ±rÅŸehir", "Kocaeli", "Konya",
            "KÃ¼tahya", "Malatya", "Manisa", "KahramanmaraÅŸ", "Mardin", "MuÄŸla", "MuÅŸ", "NevÅŸehir",
            "NiÄŸde", "Ordu", "Rize", "Sakarya", "Samsun", "Siirt", "Sinop", "Sivas", "TekirdaÄŸ",
            "Tokat", "Trabzon", "Tunceli", "ÅžanlÄ±urfa", "UÅŸak", "Van", "Yozgat", "Zonguldak",
            "Aksaray", "Bayburt", "Karaman", "KÄ±rÄ±kkale", "Batman", "ÅžÄ±rnak", "BartÄ±n", "Ardahan",
            "IÄŸdÄ±r", "Yalova", "KarabÃ¼k", "Kilis", "Osmaniye", "DÃ¼zce"
        ],
        "Greece": [
            "Attica", "Central Greece", "Central Macedonia", "Crete", "Eastern Macedonia and Thrace",
            "Epirus", "Ionian Islands", "North Aegean", "Peloponnese", "South Aegean",
            "Thessaly", "Western Greece", "Western Macedonia", "Mount Athos"
        ],
        "Romania": [
            "Alba", "Arad", "ArgeÈ™", "BacÄƒu", "Bihor", "BistriÈ›a-NÄƒsÄƒud", "BotoÈ™ani", "BrÄƒila",
            "BraÈ™ov", "BucureÈ™ti", "BuzÄƒu", "CÄƒlÄƒraÈ™i", "CaraÈ™-Severin", "Cluj", "ConstanÈ›a",
            "Covasna", "DÃ¢mboviÈ›a", "Dolj", "GalaÈ›i", "Giurgiu", "Gorj", "Harghita", "Hunedoara",
            "IalomiÈ›a", "IaÈ™i", "Ilfov", "MaramureÈ™", "MehedinÈ›i", "MureÈ™", "NeamÈ›", "Olt",
            "Prahova", "SÄƒlaj", "Satu Mare", "Sibiu", "Suceava", "Teleorman", "TimiÈ™", "Tulcea",
            "VÃ¢lcea", "Vaslui", "Vrancea"
        ],
        "Portugal": [
            "Aveiro", "Beja", "Braga", "BraganÃ§a", "Castelo Branco", "Coimbra", "Ã‰vora", "Faro",
            "Guarda", "Leiria", "Lisboa", "Portalegre", "Porto", "SantarÃ©m", "SetÃºbal", "Viana do Castelo",
            "Vila Real", "Viseu", "Azores", "Madeira"
        ],
        "Finland": [
            "Ã…land Islands", "Central Finland", "Central Ostrobothnia", "Eastern Finland", "Kainuu",
            "Kymenlaakso", "Lapland", "North Karelia", "Northern Ostrobothnia", "Northern Savonia",
            "Ostrobothnia", "PÃ¤ijÃ¤nne Tavastia", "Pirkanmaa", "Satakunta", "South Karelia",
            "Southern Ostrobothnia", "Southern Savonia", "Tavastia Proper", "Uusimaa", "Southwest Finland"
        ],
        "Denmark": [
            "Capital Region of Denmark", "Central Denmark Region", "North Denmark Region",
            "Region Zealand", "Region of Southern Denmark", "Faroe Islands", "Greenland"
        ],
        "Ireland": [
            "Carlow", "Cavan", "Clare", "Cork", "Donegal", "Dublin", "Galway", "Kerry", "Kildare",
            "Kilkenny", "Laois", "Leitrim", "Limerick", "Longford", "Louth", "Mayo", "Meath",
            "Monaghan", "Offaly", "Roscommon", "Sligo", "Tipperary", "Waterford", "Westmeath",
            "Wexford", "Wicklow"
        ],
        "Switzerland": [
            "Aargau", "Appenzell Ausserrhoden", "Appenzell Innerrhoden", "Basel-Landschaft",
            "Basel-Stadt", "Bern", "Fribourg", "Geneva", "Glarus", "GraubÃ¼nden", "Jura",
            "Lucerne", "NeuchÃ¢tel", "Nidwalden", "Obwalden", "Schaffhausen", "Schwyz",
            "Solothurn", "St. Gallen", "Thurgau", "Ticino", "Uri", "Valais", "Vaud",
            "Zug", "ZÃ¼rich"
        ],
        "Austria": [
            "Burgenland", "Carinthia", "Lower Austria", "Upper Austria", "Salzburg",
            "Styria", "Tyrol", "Vorarlberg", "Vienna"
        ],
        "Czech Republic": [
            "Prague", "Central Bohemian Region", "South Bohemian Region", "PlzeÅˆ Region",
            "Karlovy Vary Region", "ÃšstÃ­ nad Labem Region", "Liberec Region",
            "Hradec KrÃ¡lovÃ© Region", "Pardubice Region", "Olomouc Region",
            "Moravian-Silesian Region", "South Moravian Region", "ZlÃ­n Region",
            "VysoÄina Region"
        ],
        "Slovakia": [
            "Bratislava Region", "Trnava Region", "TrenÄÃ­n Region", "Nitra Region",
            "Å½ilina Region", "BanskÃ¡ Bystrica Region", "PreÅ¡ov Region", "KoÅ¡ice Region"
        ],
        "Hungary": [
            "Budapest", "BÃ¡cs-Kiskun", "Baranya", "BÃ©kÃ©s", "Borsod-AbaÃºj-ZemplÃ©n", "CsongrÃ¡d-CsanÃ¡d",
            "FejÃ©r", "GyÅ‘r-Moson-Sopron", "HajdÃº-Bihar", "Heves", "JÃ¡sz-Nagykun-Szolnok",
            "KomÃ¡rom-Esztergom", "NÃ³grÃ¡d", "Pest", "Somogy", "Szabolcs-SzatmÃ¡r-Bereg", "Tolna",
            "Vas", "VeszprÃ©m", "Zala"
        ],
        "South Korea": [
            "Seoul", "Busan", "Daegu", "Incheon", "Gwangju", "Daejeon", "Ulsan", "Sejong",
            "Gyeonggi", "Gangwon", "North Chungcheong", "South Chungcheong", "North Jeolla",
            "South Jeolla", "North Gyeongsang", "South Gyeongsang", "Jeju"
        ],
        "North Korea": [
            "Pyongyang", "Rason", "Nampo", "Kaesong", "Chagang", "North Hamgyong", 
            "South Hamgyong", "North Hwanghae", "South Hwanghae", "Kangwon", "North Pyongan",
            "South Pyongan", "Ryanggang"
        ],
        "Mongolia": [
            "Arkhangai", "Bayan-Ã–lgii", "Bayankhongor", "Bulgan", "Darkhan-Uul", "Dornod",
            "Dornogovi", "Dundgovi", "Govi-Altai", "GovisÃ¼mber", "Khentii", "Khovd", "KhÃ¶vsgÃ¶l",
            "Ã–mnÃ¶govi", "Orkhon", "Ã–vÃ¶rkhangai", "Selenge", "SÃ¼khbaatar", "TÃ¶v", "Uvs", "Zavkhan",
            "Ulaanbaatar"
        ],
        "Kazakhstan": [
            "Akmola Region", "Aktobe Region", "Almaty Region", "Atyrau Region", "East Kazakhstan Region",
            "Jambyl Region", "Karaganda Region", "Kostanay Region", "Kyzylorda Region", "Mangystau Region",
            "North Kazakhstan Region", "Pavlodar Region", "Turkistan Region", "West Kazakhstan Region",
            "Almaty", "Nur-Sultan", "Shymkent"
        ],
        "Uzbekistan": [
            "Andijan Region", "Bukhara Region", "Fergana Region", "Jizzakh Region", "Karakalpakstan",
            "Namangan Region", "Navoiy Region", "Kashkadarya Region", "Samarkand Region", "Sirdaryo Region",
            "Surxondaryo Region", "Tashkent Region", "Xorazm Region", "Tashkent"
        ],
        "Tajikistan": [
            "Dushanbe", "Districts of Republican Subordination", "Gorno-Badakhshan", "Khatlon", "Sughd"
        ],
        "Kyrgyzstan": [
            "Batken Region", "Chuy Region", "Issyk-Kul Region", "Jalal-Abad Region", "Naryn Region",
            "Osh Region", "Talas Region", "Bishkek", "Osh"
        ],
        "Turkmenistan": [
            "Ahal Region", "Balkan Region", "DaÅŸoguz Region", "Lebap Region", "Mary Region", "Ashgabat"
        ],
        "Afghanistan": [
            "Badakhshan", "Badghis", "Baghlan", "Balkh", "Bamyan", "Daykundi", "Farah", "Faryab",
            "Ghazni", "Ghor", "Helmand", "Herat", "Jowzjan", "Kabul", "Kandahar", "Kapisa",
            "Khost", "Kunar", "Kunduz", "Laghman", "Logar", "Nangarhar", "Nimruz", "Nuristan",
            "Paktia", "Paktika", "Panjshir", "Parwan", "Samangan", "Sar-e Pol", "Takhar",
            "Uruzgan", "Wardak", "Zabul"
        ],
        "Pakistan": [
            "Balochistan", "Khyber Pakhtunkhwa", "Punjab", "Sindh",
            "Islamabad Capital Territory", "Azad Kashmir", "Gilgit-Baltistan"
        ],
        "Bangladesh": [
            "Barisal Division", "Chittagong Division", "Dhaka Division", "Khulna Division",
            "Mymensingh Division", "Rajshahi Division", "Rangpur Division", "Sylhet Division"
        ],
        "Nepal": [
            "Province No. 1", "Madhesh Province", "Bagmati Province", "Gandaki Province",
            "Lumbini Province", "Karnali Province", "Sudurpashchim Province"
        ],
        "Sri Lanka": [
            "Central Province", "Eastern Province", "North Central Province", "Northern Province",
            "North Western Province", "Sabaragamuwa Province", "Southern Province", "Uva Province",
            "Western Province"
        ],
        "Myanmar": [
            "Ayeyarwady Region", "Bago Region", "Chin State", "Kachin State", "Kayah State",
            "Kayin State", "Magway Region", "Mandalay Region", "Mon State", "Naypyidaw Union Territory",
            "Rakhine State", "Sagaing Region", "Shan State", "Tanintharyi Region", "Yangon Region"
        ],
        "Thailand": [
            "Bangkok", "Amnat Charoen", "Ang Thong", "Bueng Kan", "Buriram", "Chachoengsao",
            "Chai Nat", "Chaiyaphum", "Chanthaburi", "Chiang Mai", "Chiang Rai", "Chonburi",
            "Chumphon", "Kalasin", "Kamphaeng Phet", "Kanchanaburi", "Khon Kaen", "Krabi",
            "Lampang", "Lamphun", "Loei", "Lopburi", "Mae Hong Son", "Maha Sarakham",
            "Mukdahan", "Nakhon Nayok", "Nakhon Pathom", "Nakhon Phanom", "Nakhon Ratchasima",
            "Nakhon Sawan", "Nakhon Si Thammarat", "Nan", "Narathiwat", "Nong Bua Lamphu",
            "Nong Khai", "Nonthaburi", "Pathum Thani", "Pattani", "Phang Nga", "Phatthalung",
            "Phayao", "Phetchabun", "Phetchaburi", "Phichit", "Phitsanulok", "Phra Nakhon Si Ayutthaya",
            "Phrae", "Phuket", "Prachinburi", "Prachuap Khiri Khan", "Ranong", "Ratchaburi",
            "Rayong", "Roi Et", "Sa Kaeo", "Sakon Nakhon", "Samut Prakan", "Samut Sakhon",
            "Samut Songkhram", "Saraburi", "Satun", "Sing Buri", "Sisaket", "Songkhla",
            "Sukhothai", "Suphan Buri", "Surat Thani", "Surin", "Tak", "Trang", "Trat",
            "Ubon Ratchathani", "Udon Thani", "Uthai Thani", "Uttaradit", "Yala", "Yasothon"
        ],
        "Laos": [
            "Attapeu", "Bokeo", "Bolikhamsai", "Champasak", "Houaphanh", "Khammouane", "Luang Namtha",
            "Luang Prabang", "Oudomxay", "Phongsaly", "Sainyabuli", "Salavan", "Savannakhet", "Sekong",
            "Vientiane Prefecture", "Vientiane Province", "Xaisomboun", "Xaisomboun Special Zone", "Xieng Khouang"
        ],
        "Cambodia": [
            "Banteay Meanchey", "Battambang", "Kampong Cham", "Kampong Chhnang", "Kampong Speu",
            "Kampong Thom", "Kampot", "Kandal", "Kep", "Koh Kong", "Kratie", "Mondulkiri",
            "Oddar Meanchey", "Pailin", "Phnom Penh", "Preah Sihanouk", "Preah Vihear", "Pursat",
            "Prey Veng", "Ratanakiri", "Siem Reap", "Stung Treng", "Svay Rieng", "Takeo",
            "Tboung Khmum"
        ],
        "Vietnam": [
            "An Giang", "Ba Ria-Vung Tau", "Bac Giang", "Bac Kan", "Bac Lieu", "Bac Ninh",
            "Ben Tre", "Binh Dinh", "Binh Duong", "Binh Phuoc", "Binh Thuan", "Ca Mau",
            "Can Tho", "Cao Bang", "Da Nang", "Dak Lak", "Dak Nong", "Dien Bien", "Dong Nai",
            "Dong Thap", "Gia Lai", "Ha Giang", "Ha Nam", "Ha Noi", "Ha Tinh", "Hai Duong",
            "Hai Phong", "Hau Giang", "Ho Chi Minh City", "Hoa Binh", "Hung Yen", "Khanh Hoa",
            "Kien Giang", "Kon Tum", "Lai Chau", "Lam Dong", "Lang Son", "Lao Cai", "Long An",
            "Nam Dinh", "Nghe An", "Ninh Binh", "Ninh Thuan", "Phu Tho", "Phu Yen", "Quang Binh",
            "Quang Nam", "Quang Ngai", "Quang Ninh", "Quang Tri", "Soc Trang", "Son La",
            "Tay Ninh", "Thai Binh", "Thai Nguyen", "Thanh Hoa", "Thua Thien-Hue", "Tien Giang",
            "Tra Vinh", "Tuyen Quang", "Vinh Long", "Vinh Phuc", "Yen Bai"
        ],
        "Indonesia": [
            "Aceh", "Bali", "Bangka Belitung Islands", "Banten", "Bengkulu", "Central Java",
            "Central Kalimantan", "Central Sulawesi", "East Java", "East Kalimantan",
            "East Nusa Tenggara", "Gorontalo", "Jakarta", "Jambi", "Lampung", "Maluku",
            "North Kalimantan", "North Maluku", "North Sulawesi", "North Sumatra",
            "Papua", "Riau", "Riau Islands", "South Kalimantan", "South Sulawesi",
            "South Sumatra", "Southeast Sulawesi", "Special Region of Yogyakarta",
            "West Java", "West Kalimantan", "West Nusa Tenggara", "West Papua",
            "West Sulawesi", "West Sumatra"
        ],
        "Malaysia": [
            "Johor", "Kedah", "Kelantan", "Malacca", "Negeri Sembilan", "Pahang",
            "Penang", "Perak", "Perlis", "Sabah", "Sarawak", "Selangor", "Terengganu",
            "Federal Territory of Kuala Lumpur", "Federal Territory of Labuan",
            "Federal Territory of Putrajaya"
        ],
        "Philippines": [
            "Abra", "Agusan del Norte", "Agusan del Sur", "Aklan", "Albay", "Antique",
            "Apayao", "Aurora", "Basilan", "Bataan", "Batanes", "Batangas", "Benguet",
            "Biliran", "Bohol", "Bukidnon", "Bulacan", "Cagayan", "Camarines Norte",
            "Camarines Sur", "Camiguin", "Capiz", "Catanduanes", "Cavite", "Cebu",
            "Cotabato", "Davao de Oro", "Davao del Norte", "Davao del Sur",
            "Davao Occidental", "Davao Oriental", "Dinagat Islands", "Eastern Samar",
            "Guimaras", "Ifugao", "Ilocos Norte", "Ilocos Sur", "Iloilo", "Isabela",
            "Kalinga", "La Union", "Laguna", "Lanao del Norte", "Lanao del Sur", "Leyte",
            "Maguindanao", "Marinduque", "Masbate", "Misamis Occidental",
            "Misamis Oriental", "Mountain Province", "Negros Occidental",
            "Negros Oriental", "Northern Samar", "Nueva Ecija", "Nueva Vizcaya",
            "Occidental Mindoro", "Oriental Mindoro", "Palawan", "Pampanga",
            "Pangasinan", "Quezon", "Quirino", "Rizal", "Romblon", "Samar",
            "Sarangani", "Siquijor", "Sorsogon", "South Cotabato",
            "Southern Leyte", "Sultan Kudarat", "Sulu", "Surigao del Norte",
            "Surigao del Sur", "Tarlac", "Tawi-Tawi", "Zambales", "Zamboanga del Norte",
            "Zamboanga del Sur", "Zamboanga Sibugay",
            "Metro Manila"
        ],
        "Taiwan": [
            "Changhua County", "Chiayi City", "Chiayi County", "Hsinchu City",
            "Hsinchu County", "Hualien County", "Kaohsiung City", "Keelung City",
            "Kinmen County", "Lienchiang County", "Miaoli County", "Nantou County",
            "New Taipei City", "Penghu County", "Pingtung County", "Taichung City",
            "Tainan City", "Taipei City", "Taitung County", "Taoyuan City",
            "Yilan County", "Yunlin County"
        ],
        "Iran": [
            "Alborz", "Ardabil", "Azerbaijan East", "Azerbaijan West", "Bushehr",
            "Chaharmahal and Bakhtiari", "Fars", "Gilan", "Golestan", "Hamadan",
            "Hormozgan", "Ilam", "Isfahan", "Kerman", "Kermanshah", "Khorasan North",
            "Khorasan Razavi", "Khorasan South", "Khuzestan", "Kohgiluyeh and Boyer-Ahmad",
            "Kurdistan", "Lorestan", "Markazi", "Mazandaran", "Qazvin", "Qom", "Semnan",
            "Sistan and Baluchestan", "Tehran", "Yazd", "Zanjan"
        ],
        "Iraq": [
            "Al Anbar", "Babil", "Baghdad", "Basra", "Dhi Qar", "Diyala", "Dohuk",
            "Erbil", "Karbala", "Kirkuk", "Maysan", "Muthanna", "Najaf", "Nineveh",
            "Qadisiyyah", "Saladin", "Sulaymaniyah", "Wasit"
        ],
        "Saudi Arabia": [
            "Al Bahah", "Al Jawf", "Al Madinah", "Al-Qassim", "Asir", "Eastern Province",
            "Ha'il", "Jazan", "Makkah", "Najran", "Northern Borders", "Riyadh", "Tabuk"
        ],
        "Yemen": [
            "Abyan", "Aden", "Al Bayda'", "Al Hudaydah", "Al Jawf", "Al Mahrah",
            "Al Mahwit", "Amanat Al Asimah", "Dhamar", "Hadhramaut", "Hajjah", "Ibb",
            "Lahij", "Ma'rib", "Raymah", "Sa'dah", "Sana'a", "Shabwah", "Socotra", "Ta'izz"
        ],
        "Syria": [
            "Aleppo", "Damascus", "Daraa", "Deir ez-Zor", "Hama", "Al-Hasakah", "Homs",
            "Idlib", "Latakia", "Quneitra", "Raqqa", "Rif Dimashq", "As-Suwayda", "Tartus"
        ],
        "Jordan": [
            "Ajloun", "Amman", "Aqaba", "Balqa", "Irbid", "Jerash", "Karak", "Ma'an",
            "Madaba", "Mafraq", "Tafilah", "Zarqa"
        ],
        "Israel": [
            "Central District", "Haifa District", "Jerusalem District", "Northern District",
            "Southern District", "Tel Aviv District"
        ],
        "Lebanon": [
            "Akkar", "Baalbek-Hermel", "Beirut", "Beqaa", "Mount Lebanon",
            "Nabatieh", "North Lebanon", "South Lebanon"
        ],
        "Kuwait": [
            "Al Ahmadi", "Al Asimah", "Al Farwaniyah", "Al Jahra", "Hawalli", "Mubarak Al-Kabeer"
        ],
        "Bahrain": [
            "Capital Governorate", "Muharraq Governorate", "Northern Governorate",
            "Southern Governorate"
        ],
        "Qatar": [
            "Al Daayen", "Al Khor", "Al Rayyan", "Al Shamal", "Al Wakrah", "Al-Shahaniya",
            "Doha", "Umm Salal"
        ],
        "United Arab Emirates": [
            "Abu Dhabi", "Ajman", "Dubai", "Fujairah", "Ras Al Khaimah",
            "Sharjah", "Umm Al Quwain"
        ],
        "Oman": [
            "Ad Dakhiliyah", "Ad Dhahirah", "Al Batinah North", "Al Batinah South",
            "Al Buraymi", "Al Wusta", "Ash Sharqiyah North", "Ash Sharqiyah South",
            "Dhofar", "Muscat", "Musandam"
        ],
        "Brunei": [
            "Belait", "Brunei-Muara", "Temburong", "Tutong"
        ],
        "Timor-Leste": [
            "Aileu", "Ainaro", "Baucau", "Bobonaro", "Cova Lima", "Dili", "Ermera",
            "Lautem", "LiquiÃ§Ã¡", "Manatuto", "Manufahi", "Oecusse", "Viqueque"
        ],
        "Singapore": [
            "Central Region", "East Region", "North Region", "North-East Region", "West Region"
        ],
        "Armenia": [
            "Aragatsotn", "Ararat", "Armavir", "Gegharkunik", "Kotayk", "Lori", "Shirak",
            "Syunik", "Tavush", "Vayots Dzor", "Yerevan"
        ],
        "Azerbaijan": [
            "Absheron", "Agdam", "Agdash", "Agstafa", "Agsu", "Astara", "Baku", "Balakan",
            "Barda", "Beylagan", "Bilasuvar", "Dashkasan", "Fizuli", "Ganja", "Gobustan",
            "Goranboy", "Goychay", "Goygol", "Hajigabul", "Imishli", "Ismayilli", "Jabrayil",
            "Jalilabad", "Kalbajar", "Khachmaz", "Khizi", "Khojaly", "Khojavend", "Kurdamir",
            "Lachin", "Lankaran", "Lerik", "Masally", "Mingachevir", "Naftalan", "Nakhchivan",
            "Neftchala", "Oghuz", "Qabala", "Qakh", "Qazakh", "Quba", "Qubadli", "Qusar",
            "Saatly", "Sabirabad", "Salyan", "Shabran", "Shaki", "Shamakhi", "Shamkir",
            "Shirvan", "Shusha", "Siazan", "Sumgayit", "Tartar", "Tovuz", "Ujar", "Yardimli",
            "Yevlakh", "Zangilan", "Zaqatala", "Zardab"
        ],
        "Georgia": [
            "Abkhazia", "Adjara", "Guria", "Imereti", "Kakheti", "Kvemo Kartli",
            "Mtskheta-Mtianeti", "Racha-Lechkhumi and Kvemo Svaneti", "Samegrelo-Zemo Svaneti",
            "Samtskhe-Javakheti", "Shida Kartli", "Tbilisi"
        ],
        "Maldives": [
            "Addu City", "Fuvahmulah City", "Male' City", "North Central Province",
            "North Province", "South Central Province", "South Province", "Upper North Province",
            "Upper South Province"
        ],
        "Bhutan": [
            "Bumthang", "Chukha", "Dagana", "Gasa", "Haa", "Lhuntse", "Mongar", "Paro",
            "Pemagatshel", "Punakha", "Samdrup Jongkhar", "Samtse", "Sarpang", "Thimphu",
            "Trashigang", "Trashiyangtse", "Trongsa", "Tsirang", "Wangdue Phodrang",
            "Zhemgang"
        ],
        "Papua New Guinea": [
            "Bougainville", "Central", "Chimbu", "East New Britain", "East Sepik",
            "Eastern Highlands", "Enga", "Gulf", "Hela", "Jiwaka", "Madang", "Manus",
            "Milne Bay", "Morobe", "National Capital District", "New Ireland", "Northern",
            "Southern Highlands", "West New Britain", "West Sepik", "Western",
            "Western Highlands"
        ],
        "Fiji": [
            "Central Division", "Eastern Division", "Northern Division", "Western Division",
            "Rotuma"
        ],
        "Solomon Islands": [
            "Central Province", "Choiseul", "Guadalcanal", "Honiara City", "Isabel",
            "Makira-Ulawa", "Malaita", "Rennell and Bellona", "Temotu", "Western Province"
        ],
        "Vanuatu": [
            "Malampa", "Penama", "Sanma", "Shefa", "Tafea", "Torba"
        ],
        "Samoa": [
            "A'ana", "Aiga-i-le-Tai", "Atua", "Fa'asaleleaga", "Gaga'emauga", "Gaga'ifomauga",
            "Palauli", "Satupa'itea", "Tuamasaga", "Va'a-o-Fonoti", "Vaisigano"
        ],
        "Kiribati": [
            "Gilbert Islands", "Line Islands", "Phoenix Islands"
        ],
        "Tonga": [
            "Eua", "Ha'apai", "Niuas", "Tongatapu", "Vava'u"
        ],
        "Micronesia": [
            "Chuuk", "Kosrae", "Pohnpei", "Yap"
        ],
        "Marshall Islands": [
            "Ailinglaplap", "Ailuk", "Arno", "Aur", "Bikini", "Ebon", "Enewetak",
            "Jabat", "Jaluit", "Kili", "Kwajalein", "Lae", "Lib", "Likiep", "Majuro",
            "Maloelap", "Mejit", "Mili", "Namdrik", "Namu", "Rongelap", "Ujae", "Ujelang",
            "Utirik", "Wotho", "Wotje"
        ],
        "Palau": [
            "Aimeliik", "Airai", "Angaur", "Hatohobei", "Kayangel", "Koror", "Melekeok",
            "Ngaraard", "Ngarchelong", "Ngardmau", "Ngatpang", "Ngchesar", "Ngeremlengui",
            "Ngiwal", "Peleliu", "Sonsorol"
        ],
        "Nauru": [
            "Aiwo", "Anabar", "Anetan", "Anibare", "Baiti", "Boe", "Buada", "Denigomodu",
            "Ewa", "Ijuw", "Meneng", "Nibok", "Uaboe", "Yaren"
        ],
        "Tuvalu": [
            "Funafuti", "Nanumanga", "Nanumea", "Niulakita", "Niutao", "Nui", "Nukufetau",
            "Nukulaelae", "Vaitupu"
        ],
        "Albania": [
            "Berat", "DibÃ«r", "DurrÃ«s", "Elbasan", "Fier", "GjirokastÃ«r", "KorÃ§Ã«",
            "KukÃ«s", "LezhÃ«", "ShkodÃ«r", "Tirana", "VlorÃ«"
        ],
        "Belarus": [
            "Brest Region", "Gomel Region", "Grodno Region", "Minsk Region", "Mogilev Region",
            "Vitebsk Region", "Minsk City"
        ],
        "Bulgaria": [
            "Blagoevgrad", "Burgas", "Dobrich", "Gabrovo", "Haskovo", "Kardzhali", "Kyustendil",
            "Lovech", "Montana", "Pazardzhik", "Pernik", "Pleven", "Plovdiv", "Razgrad", "Ruse",
            "Shumen", "Silistra", "Sliven", "Smolyan", "Sofia City", "Sofia Province",
            "Stara Zagora", "Targovishte", "Varna", "Veliko Tarnovo", "Vidin", "Vratsa", "Yambol"
        ],
        "Croatia": [
            "Zagreb City", "Bjelovar-Bilogora", "Brod-Posavina", "Dubrovnik-Neretva", "Istria",
            "Karlovac", "Koprivnica-KriÅ¾evci", "Krapina-Zagorje", "Lika-Senj", "MeÄ‘imurje",
            "Osijek-Baranja", "PoÅ¾ega-Slavonia", "Primorje-Gorski Kotar", "Å ibenik-Knin",
            "Sisak-Moslavina", "Split-Dalmatia", "VaraÅ¾din", "Virovitica-Podravina",
            "Vukovar-Syrmia", "Zadar", "Zagreb County"
        ],
        "Estonia": [
            "Harju", "Hiiu", "Ida-Viru", "JÃµgeva", "JÃ¤rva", "LÃ¤Ã¤ne", "LÃ¤Ã¤ne-Viru", "PÃµlva",
            "PÃ¤rnu", "Rapla", "Saare", "Tartu", "Valga", "Viljandi", "VÃµru"
        ],
        "Latvia": [
            "Riga", "Daugavpils", "Jelgava", "JÄ“kabpils", "JÅ«rmala", "LiepÄja", "RÄ“zekne",
            "Valmiera", "Ventspils", "Aizkraukle Municipality", "AlÅ«ksne Municipality",
            "AugÅ¡daugava Municipality", "Balvi Municipality", "Bauska Municipality",
            "CÄ“sis Municipality", "Dobele Municipality", "Gulbene Municipality",
            "KrÄslava Municipality", "KuldÄ«ga Municipality", "LimbaÅ¾i Municipality",
            "LÄ«vÄni Municipality", "Ludza Municipality", "Madona Municipality",
            "MÄrupe Municipality", "Ogre Municipality", "Olaine Municipality",
            "PreiÄ¼i Municipality", "RÄ“zekne Municipality", "RopaÅ¾i Municipality",
            "Salaspils Municipality", "Saldus Municipality", "Saulkrasti Municipality",
            "Sigulda Municipality", "Smiltene Municipality", "Talsi Municipality",
            "Tukums Municipality", "Valka Municipality", "VarakÄ¼Äni Municipality",
            "Ventspils Municipality"
        ],
        "Lithuania": [
            "Alytus County", "Kaunas County", "KlaipÄ—da County", "MarijampolÄ— County",
            "PanevÄ—Å¾ys County", "Å iauliai County", "TauragÄ— County", "TelÅ¡iai County",
            "Utena County", "Vilnius County"
        ],
        "Moldova": [
            "Anenii Noi", "Basarabeasca", "Briceni", "Cahul", "CÄƒlÄƒraÈ™i", "Cantemir",
            "CÄƒuÈ™eni", "CimiÈ™lia", "Criuleni", "DonduÈ™eni", "Drochia", "DubÄƒsari",
            "EdineÈ›", "FÄƒleÈ™ti", "FloreÈ™ti", "Glodeni", "HÃ®nceÈ™ti", "Ialoveni",
            "Leova", "Nisporeni", "OcniÈ›a", "Orhei", "Rezina", "RÃ®È™cani", "SÃ®ngerei",
            "È˜oldÄƒneÈ™ti", "Soroca", "StrÄƒÈ™eni", "È˜tefan VodÄƒ", "Taraclia", "TeleneÈ™ti",
            "Ungheni", "BÄƒlÈ›i Municipality", "ChiÈ™inÄƒu Municipality", "Comrat Municipality",
            "Gagauzia", "Transnistria"
        ],
        "Montenegro": [
            "Andrijevica", "Bar", "Berane", "Bijelo Polje", "Budva", "Cetinje",
            "Danilovgrad", "Gusinje", "Herceg Novi", "KolaÅ¡in", "Kotor", "Mojkovac",
            "NikÅ¡iÄ‡", "Petnjica", "Plav", "Pljevlja", "PluÅ¾ine", "Podgorica",
            "RoÅ¾aje", "Å avnik", "Tivat", "Tuzi", "Ulcinj", "Å½abljak"
        ],
        "North Macedonia": [
            "Eastern Region", "Northeastern Region", "Pelagonia Region", "Polog Region",
            "Skopje Region", "Southeastern Region", "Southwestern Region", "Vardar Region"
        ],
        "Serbia": [
            "Belgrade", "North BaÄka", "Central Banat", "North Banat", "South Banat",
            "West BaÄka", "South BaÄka", "Srem", "MaÄva", "Kolubara", "Podunavlje",
            "BraniÄevo", "Å umadija", "Pomoravlje", "Bor", "ZajeÄar", "Zlatibor",
            "Moravica", "RaÅ¡ka", "Rasina", "NiÅ¡ava", "Toplica", "Pirot", "Jablanica",
            "PÄinja", "Kosovo", "PeÄ‡", "Prizren", "Kosovska Mitrovica", "Kosovo-Pomoravlje"
        ],
        "Slovenia": [
            "Central Slovenia", "Coastalâ€“Karst", "Drava", "Gorizia", "Lower Sava",
            "Mura", "Savinja", "Southeast Slovenia", "Upper Carniola", "Carinthia",
            "Central Sava", "Littoralâ€“Inner Carniola"
        ],
        "Cyprus": [
            "Famagusta", "Kyrenia", "Larnaca", "Limassol", "Nicosia", "Paphos"
        ],
        "Malta": [
            "Gozo Region", "Malta Majjistral", "Malta Xlokk", "Northern Region",
            "Southern Region"
        ],
        "Luxembourg": [
            "Luxembourg", "Capellen", "Esch-sur-Alzette", "Mersch", "Clervaux",
            "Diekirch", "Redange", "Vianden", "Wiltz", "Echternach", "Grevenmacher",
            "Remich"
        ],
        "Liechtenstein": [
            "Balzers", "Eschen", "Gamprin", "Mauren", "Planken", "Ruggell",
            "Schaan", "Schellenberg", "Triesen", "Triesenberg", "Vaduz"
        ],
        "Monaco": [
            "Monte Carlo", "La Condamine", "Fontvieille", "La Colle", "Les RÃ©voires",
            "Moneghetti", "Saint Roman", "Larvotto", "La Rousse"
        ],
        "San Marino": [
            "Acquaviva", "Borgo Maggiore", "Chiesanuova", "Domagnano", "Faetano",
            "Fiorentino", "Montegiardino", "San Marino City", "Serravalle"
        ],
        "Vatican City": [
            "Vatican City State"
        ],
        "Argentina": [
            "Buenos Aires", "Catamarca", "Chaco", "Chubut", "CÃ³rdoba", "Corrientes",
            "Entre RÃ­os", "Formosa", "Jujuy", "La Pampa", "La Rioja", "Mendoza",
            "Misiones", "NeuquÃ©n", "RÃ­o Negro", "Salta", "San Juan", "San Luis",
            "Santa Cruz", "Santa Fe", "Santiago del Estero", "Tierra del Fuego",
            "TucumÃ¡n", "Buenos Aires City"
        ],
        "Bolivia": [
            "Beni", "Chuquisaca", "Cochabamba", "La Paz", "Oruro", "Pando", "PotosÃ­",
            "Santa Cruz", "Tarija"
        ],
        "Chile": [
            "Arica y Parinacota", "TarapacÃ¡", "Antofagasta", "Atacama", "Coquimbo",
            "ValparaÃ­so", "Santiago Metropolitan", "O'Higgins", "Maule", "Ã‘uble", "BiobÃ­o",
            "AraucanÃ­a", "Los RÃ­os", "Los Lagos", "AysÃ©n", "Magallanes"
        ],
        "Colombia": [
            "Amazonas", "Antioquia", "Arauca", "AtlÃ¡ntico", "BolÃ­var", "BoyacÃ¡", "Caldas",
            "CaquetÃ¡", "Casanare", "Cauca", "Cesar", "ChocÃ³", "CÃ³rdoba", "Cundinamarca",
            "GuainÃ­a", "Guaviare", "Huila", "La Guajira", "Magdalena", "Meta", "NariÃ±o",
            "Norte de Santander", "Putumayo", "QuindÃ­o", "Risaralda", "San AndrÃ©s and Providencia",
            "Santander", "Sucre", "Tolima", "Valle del Cauca", "VaupÃ©s", "Vichada",
            "BogotÃ¡ Capital District"
        ],
        "Ecuador": [
            "Azuay", "BolÃ­var", "CaÃ±ar", "Carchi", "Chimborazo", "Cotopaxi", "El Oro",
            "Esmeraldas", "GalÃ¡pagos", "Guayas", "Imbabura", "Loja", "Los RÃ­os", "ManabÃ­",
            "Morona Santiago", "Napo", "Orellana", "Pastaza", "Pichincha", "Santa Elena",
            "Santo Domingo de los TsÃ¡chilas", "SucumbÃ­os", "Tungurahua", "Zamora Chinchipe"
        ],
        "Paraguay": [
            "Alto Paraguay", "Alto ParanÃ¡", "Amambay", "BoquerÃ³n", "CaaguazÃº", "CaazapÃ¡",
            "CanindeyÃº", "Central", "ConcepciÃ³n", "Cordillera", "GuairÃ¡", "ItapÃºa",
            "Misiones", "Ã‘eembucÃº", "ParaguarÃ­", "Presidente Hayes", "San Pedro",
            "AsunciÃ³n Capital District"
        ],
        "Peru": [
            "Amazonas", "Ãncash", "ApurÃ­mac", "Arequipa", "Ayacucho", "Cajamarca", "Callao",
            "Cusco", "Huancavelica", "HuÃ¡nuco", "Ica", "JunÃ­n", "La Libertad", "Lambayeque",
            "Lima", "Loreto", "Madre de Dios", "Moquegua", "Pasco", "Piura", "Puno",
            "San MartÃ­n", "Tacna", "Tumbes", "Ucayali", "Lima Metropolitan"
        ],
        "Uruguay": [
            "Artigas", "Canelones", "Cerro Largo", "Colonia", "Durazno", "Flores",
            "Florida", "Lavalleja", "Maldonado", "Montevideo", "PaysandÃº", "RÃ­o Negro",
            "Rivera", "Rocha", "Salto", "San JosÃ©", "Soriano", "TacuarembÃ³", "Treinta y Tres"
        ],
        "Venezuela": [
            "Amazonas", "AnzoÃ¡tegui", "Apure", "Aragua", "Barinas", "BolÃ­var", "Carabobo",
            "Cojedes", "Delta Amacuro", "FalcÃ³n", "GuÃ¡rico", "Lara", "MÃ©rida", "Miranda",
            "Monagas", "Nueva Esparta", "Portuguesa", "Sucre", "TÃ¡chira", "Trujillo",
            "Vargas", "Yaracuy", "Zulia", "Capital District", "Federal Dependencies"
        ],
        "Guyana": [
            "Barima-Waini", "Cuyuni-Mazaruni", "Demerara-Mahaica", "East Berbice-Corentyne",
            "Essequibo Islands-West Demerara", "Mahaica-Berbice", "Pomeroon-Supenaam",
            "Potaro-Siparuni", "Upper Demerara-Berbice", "Upper Takutu-Upper Essequibo"
        ],
        "Suriname": [
            "Brokopondo", "Commewijne", "Coronie", "Marowijne", "Nickerie", "Para",
            "Paramaribo", "Saramacca", "Sipaliwini", "Wanica"
        ],
        "Belize": [
            "Belize District", "Cayo District", "Corozal District", "Orange Walk District",
            "Stann Creek District", "Toledo District"
        ],
        "Costa Rica": [
            "Alajuela", "Cartago", "Guanacaste", "Heredia", "LimÃ³n", "Puntarenas",
            "San JosÃ©"
        ],
        "El Salvador": [
            "AhuachapÃ¡n", "CabaÃ±as", "Chalatenango", "CuscatlÃ¡n", "La Libertad", "La Paz",
            "La UniÃ³n", "MorazÃ¡n", "San Miguel", "San Salvador", "San Vicente",
            "Santa Ana", "Sonsonate", "UsulutÃ¡n"
        ],
        "Guatemala": [
            "Alta Verapaz", "Baja Verapaz", "Chimaltenango", "Chiquimula", "El Progreso",
            "Escuintla", "Guatemala", "Huehuetenango", "Izabal", "Jalapa", "Jutiapa",
            "PetÃ©n", "Quetzaltenango", "QuichÃ©", "Retalhuleu", "SacatepÃ©quez",
            "San Marcos", "Santa Rosa", "SololÃ¡", "SuchitepÃ©quez", "TotonicapÃ¡n", "Zacapa"
        ],
        "Honduras": [
            "AtlÃ¡ntida", "Choluteca", "ColÃ³n", "Comayagua", "CopÃ¡n", "CortÃ©s", "El ParaÃ­so",
            "Francisco MorazÃ¡n", "Gracias a Dios", "IntibucÃ¡", "Islas de la BahÃ­a",
            "La Paz", "Lempira", "Ocotepeque", "Olancho", "Santa BÃ¡rbara", "Valle", "Yoro"
        ],
        "Nicaragua": [
            "Boaco", "Carazo", "Chinandega", "Chontales", "Costa Caribe Norte",
            "Costa Caribe Sur", "EstelÃ­", "Granada", "Jinotega", "LeÃ³n", "Madriz",
            "Managua", "Masaya", "Matagalpa", "Nueva Segovia", "RÃ­o San Juan", "Rivas"
        ],
        "Panama": [
            "Bocas del Toro", "ChiriquÃ­", "CoclÃ©", "ColÃ³n", "DariÃ©n", "EmberÃ¡-Wounaan",
            "Guna Yala", "Herrera", "Los Santos", "NgÃ¤be-BuglÃ©", "PanamÃ¡", "PanamÃ¡ Oeste",
            "Veraguas"
        ],
        "Antigua and Barbuda": [
            "Saint George", "Saint John", "Saint Mary", "Saint Paul", "Saint Peter",
            "Saint Philip", "Barbuda", "Redonda"
        ],
        "Bahamas": [
            "Acklins", "Berry Islands", "Bimini", "Black Point", "Cat Island", "Central Abaco",
            "Central Andros", "Central Eleuthera", "City of Freeport", "Crooked Island",
            "East Grand Bahama", "Exuma", "Grand Cay", "Harbour Island", "Hope Town",
            "Inagua", "Long Island", "Mangrove Cay", "Mayaguana", "Moore's Island",
            "North Abaco", "North Andros", "North Eleuthera", "Ragged Island", "Rum Cay",
            "San Salvador", "South Abaco", "South Andros", "South Eleuthera",
            "Spanish Wells", "West Grand Bahama"
        ],
        "Barbados": [
            "Christ Church", "Saint Andrew", "Saint George", "Saint James", "Saint John",
            "Saint Joseph", "Saint Lucy", "Saint Michael", "Saint Peter", "Saint Philip",
            "Saint Thomas"
        ],
        "Cuba": [
            "Artemisa", "CamagÃ¼ey", "Ciego de Ãvila", "Cienfuegos", "Granma", "GuantÃ¡namo",
            "Havana", "HolguÃ­n", "Isle of Youth", "Las Tunas", "Matanzas", "Mayabeque",
            "Pinar del RÃ­o", "Sancti SpÃ­ritus", "Santiago de Cuba", "Villa Clara"
        ],
        "Dominica": [
            "Saint Andrew", "Saint David", "Saint George", "Saint John", "Saint Joseph",
            "Saint Luke", "Saint Mark", "Saint Patrick", "Saint Paul", "Saint Peter"
        ],
        "Dominican Republic": [
            "Azua", "Baoruco", "Barahona", "DajabÃ³n", "Distrito Nacional", "Duarte",
            "El Seibo", "ElÃ­as PiÃ±a", "Espaillat", "Hato Mayor", "Hermanas Mirabal",
            "Independencia", "La Altagracia", "La Romana", "La Vega", "MarÃ­a Trinidad SÃ¡nchez",
            "MonseÃ±or Nouel", "Monte Cristi", "Monte Plata", "Pedernales", "Peravia",
            "Puerto Plata", "SamanÃ¡", "San CristÃ³bal", "San JosÃ© de Ocoa", "San Juan",
            "San Pedro de MacorÃ­s", "Santiago", "Santiago RodrÃ­guez", "Santo Domingo",
            "SÃ¡nchez RamÃ­rez", "Valverde"
        ],
        "Grenada": [
            "Saint Andrew", "Saint David", "Saint George", "Saint John", "Saint Mark",
            "Saint Patrick", "Carriacou and Petite Martinique"
        ],
        "Haiti": [
            "Artibonite", "Centre", "Grand'Anse", "Nippes", "Nord", "Nord-Est", "Nord-Ouest",
            "Ouest", "Sud", "Sud-Est"
        ],
        "Jamaica": [
            "Clarendon", "Hanover", "Kingston", "Manchester", "Portland", "Saint Andrew",
            "Saint Ann", "Saint Catherine", "Saint Elizabeth", "Saint James", "Saint Mary",
            "Saint Thomas", "Trelawny", "Westmoreland"
        ],
        "Saint Kitts and Nevis": [
            "Christ Church Nichola Town", "Saint Anne Sandy Point", "Saint George Basseterre",
            "Saint John Capisterre", "Saint Mary Cayon", "Saint Paul Capisterre",
            "Saint Peter Basseterre", "Saint Thomas Middle Island", "Trinity Palmetto Point",
            "Saint George Gingerland", "Saint James Windward", "Saint John Figtree",
            "Saint Mary Cayon", "Saint Paul Charlestown", "Saint Thomas Lowland"
        ],
        "Saint Lucia": [
            "Anse la Raye", "Castries", "Choiseul", "Dauphin", "Dennery", "Gros Islet",
            "Laborie", "Micoud", "Praslin", "SoufriÃ¨re", "Vieux Fort"
        ],
        "Saint Vincent and the Grenadines": [
            "Charlotte", "Grenadines", "Saint Andrew", "Saint David", "Saint George",
            "Saint Patrick"
        ],
        "Trinidad and Tobago": [
            "Couva-Tabaquite-Talparo", "Diego Martin", "Eastern Tobago", "Penal-Debe",
            "Princes Town", "Rio Claro-Mayaro", "San Fernando", "Sangre Grande",
            "San Juan-Laventille", "Siparia", "Tunapuna-Piarco", "Port of Spain",
            "Point Fortin", "Western Tobago", "Chaguanas", "Borough of Arima",
            "Borough of Point Fortin"
        ],
        "Algeria": [
            "Adrar", "AÃ¯n Defla", "AÃ¯n TÃ©mouchent", "Algiers", "Annaba", "Batna", "BÃ©char",
            "BÃ©jaÃ¯a", "Biskra", "Blida", "Bordj Bou ArrÃ©ridj", "Bouira", "BoumerdÃ¨s", "Chlef",
            "Constantine", "Djelfa", "El Bayadh", "El Oued", "El Tarf", "GhardaÃ¯a", "Guelma",
            "Illizi", "Jijel", "Khenchela", "Laghouat", "Mascara", "MÃ©dÃ©a", "Mila", "Mostaganem",
            "M'Sila", "NaÃ¢ma", "Oran", "Ouargla", "Oum El Bouaghi", "Relizane", "SaÃ¯da", "SÃ©tif",
            "Sidi Bel AbbÃ¨s", "Skikda", "Souk Ahras", "Tamanghasset", "TÃ©bessa", "Tiaret", "Tindouf",
            "Tipaza", "Tissemsilt", "Tizi Ouzou", "Tlemcen"
        ],
        "Angola": [
            "Bengo", "Benguela", "BiÃ©", "Cabinda", "Cuando Cubango", "Cuanza Norte", "Cuanza Sul",
            "Cunene", "Huambo", "HuÃ­la", "Luanda", "Lunda Norte", "Lunda Sul", "Malanje", "Moxico",
            "Namibe", "UÃ­ge", "Zaire"
        ],
        "Benin": [
            "Alibori", "Atakora", "Atlantique", "Borgou", "Collines", "Donga", "Kouffo", "Littoral",
            "Mono", "OuÃ©mÃ©", "Plateau", "Zou"
        ],
        "Botswana": [
            "Central", "Ghanzi", "Kgalagadi", "Kgatleng", "Kweneng", "North-East", "North-West",
            "South-East", "Southern"
        ],
        "Burkina Faso": [
            "Boucle du Mouhoun", "Cascades", "Centre", "Centre-Est", "Centre-Nord", "Centre-Ouest",
            "Centre-Sud", "Est", "Hauts-Bassins", "Nord", "Plateau-Central", "Sahel", "Sud-Ouest"
        ],
        "Burundi": [
            "Bubanza", "Bujumbura Mairie", "Bujumbura Rural", "Bururi", "Cankuzo", "Cibitoke", "Gitega",
            "Karuzi", "Kayanza", "Kirundo", "Makamba", "Muramvya", "Muyinga", "Mwaro", "Ngozi", "Rutana",
            "Ruyigi"
        ],
        "Cabo Verde": [
            "Boa Vista", "Brava", "Fogo", "Maio", "Mosteiros", "Paul", "Porto Novo", "Praia", "Ribeira Brava",
            "Ribeira Grande", "Ribeira Grande de Santiago", "Sal", "Santa Catarina", "Santa Catarina do Fogo",
            "Santa Cruz", "SÃ£o Domingos", "SÃ£o Filipe", "SÃ£o LourenÃ§o dos Ã“rgÃ£os", "SÃ£o Miguel", "SÃ£o Salvador do Mundo",
            "SÃ£o Vicente", "Tarrafal", "Tarrafal de SÃ£o Nicolau"
        ],
        "Cameroon": [
            "Adamawa", "Centre", "East", "Far North", "Littoral", "North", "Northwest", "South", "Southwest", "West"
        ],
        "Central African Republic": [
            "Bamingui-Bangoran", "Bangui", "Basse-Kotto", "Haute-Kotto", "Haut-Mbomou", "KÃ©mo", "Lobaye",
            "MambÃ©rÃ©-KadÃ©Ã¯", "Mbomou", "Nana-GrÃ©bizi", "Nana-MambÃ©rÃ©", "Ombella-M'Poko", "Ouaka", "Ouham",
            "Ouham-PendÃ©", "Sangha-MbaÃ©rÃ©", "Vakaga"
        ],
        "Chad": [
            "Bahr el Gazel", "Batha", "Borkou", "Chari-Baguirmi", "Ennedi-Est", "Ennedi-Ouest", "GuÃ©ra",
            "Hadjer-Lamis", "Kanem", "Lac", "Logone Occidental", "Logone Oriental", "Mandoul", "Mayo-Kebbi Est",
            "Mayo-Kebbi Ouest", "Moyen-Chari", "N'Djamena", "OuaddaÃ¯", "Salamat", "Sila", "TandjilÃ©", "Tibesti",
            "Wadi Fira"
        ],
        "Comoros": [
            "Anjouan", "Grande Comore", "MohÃ©li"
        ],
        "Congo": [
            "Bouenza", "Brazzaville", "Cuvette", "Cuvette-Ouest", "Kouilou", "LÃ©koumou", "Likouala", "Niari",
            "Plateaux", "Pointe-Noire", "Pool", "Sangha"
        ],
        "CÃ´te d'Ivoire": [
            "Abidjan", "Bas-Sassandra", "ComoÃ©", "DenguÃ©lÃ©", "GÃ´h-Djiboua", "Lacs", "Lagunes", "Montagnes",
            "Sassandra-MarahouÃ©", "Savanes", "VallÃ©e du Bandama", "Woroba", "Yamoussoukro", "Zanzan"
        ],
        "Democratic Republic of the Congo": [
            "Bas-Uele", "Ã‰quateur", "Haut-Katanga", "Haut-Lomami", "Haut-Uele", "Ituri", "KasaÃ¯", "KasaÃ¯ Central",
            "KasaÃ¯ Oriental", "Kinshasa", "Kongo Central", "Kwango", "Kwilu", "Lomami", "Lualaba", "Mai-Ndombe",
            "Maniema", "Mongala", "Nord-Kivu", "Nord-Ubangi", "Sankuru", "Sud-Kivu", "Sud-Ubangi", "Tanganyika",
            "Tshopo", "Tshuapa"
        ],
        "Djibouti": [
            "Ali Sabieh", "Arta", "Dikhil", "Djibouti", "Obock", "Tadjourah"
        ],
        "Egypt": [
            "Alexandria", "Aswan", "Asyut", "Beheira", "Beni Suef", "Cairo", "Dakahlia", "Damietta", "Faiyum",
            "Gharbia", "Giza", "Ismailia", "Kafr El Sheikh", "Luxor", "Matruh", "Minya", "Monufia", "New Valley",
            "North Sinai", "Port Said", "Qalyubia", "Qena", "Red Sea", "Sharqia", "Sohag", "South Sinai", "Suez"
        ],
        "Equatorial Guinea": [
            "AnnobÃ³n", "Bioko Norte", "Bioko Sur", "Centro Sur", "KiÃ©-Ntem", "Litoral", "Wele-Nzas"
        ],
        "Eritrea": [
            "Anseba", "Debub", "Debub-Keih-Bahri", "Gash-Barka", "Maekel", "Semien-Keih-Bahri"
        ],
        "Eswatini": [
            "Hhohho", "Lubombo", "Manzini", "Shiselweni"
        ],
        "Ethiopia": [
            "Addis Ababa", "Afar", "Amhara", "Benishangul-Gumuz", "Dire Dawa", "Gambela", "Harari", "Oromia",
            "Sidama", "Somali", "South West Ethiopia Peoples", "Southern Nations, Nationalities, and Peoples",
            "Tigray"
        ],
        "Gabon": [
            "Estuaire", "Haut-OgoouÃ©", "Moyen-OgoouÃ©", "NgouniÃ©", "Nyanga", "OgoouÃ©-Ivindo", "OgoouÃ©-Lolo",
            "OgoouÃ©-Maritime", "Woleu-Ntem"
        ],
        "Gambia": [
        ],
        "Zimbabwe": [
            "Bulawayo", "Harare", "Manicaland", "Mashonaland Central", "Mashonaland East", "Mashonaland West",
            "Masvingo", "Matabeleland North", "Matabeleland South", "Midlands"
        ],
        "Palestine": [
            "Bethlehem", "Deir al-Balah", "Gaza", "Hebron", "Jenin", "Jericho", "Jerusalem", "Khan Yunis",
            "Nablus", "North Gaza", "Qalqilya", "Ramallah and al-Bireh", "Rafah", "Salfit", "Tubas", "Tulkarm"
        ],
        "Maldives": [
            "Addu City", "Fuvahmulah City", "Male' City", "North Central Province", "North Province",
            "South Central Province", "South Province", "Upper North Province", "Upper South Province"
        ],
        "Bhutan": [
            "Bumthang", "Chukha", "Dagana", "Gasa", "Haa", "Lhuntse", "Mongar", "Paro", "Pemagatshel",
            "Punakha", "Samdrup Jongkhar", "Samtse", "Sarpang", "Thimphu", "Trashigang", "Trashiyangtse",
            "Trongsa", "Tsirang", "Wangdue Phodrang", "Zhemgang"
        ],
        "Timor-Leste": [
            "Aileu", "Ainaro", "Baucau", "Bobonaro", "Cova Lima", "Dili", "Ermera", "Lautem", "LiquiÃ§Ã¡",
            "Manatuto", "Manufahi", "Oecusse", "Viqueque"
        ],
        "Andorra": [
            "Andorra la Vella", "Canillo", "Encamp", "Escaldes-Engordany", "La Massana", "Ordino", "Sant JuliÃ  de LÃ²ria"
        ],
        "Bosnia and Herzegovina": [
            "BrÄko District", "Federation of Bosnia and Herzegovina", "Republika Srpska"
        ],
        "Iceland": [
            "Capital Region", "Eastern Region", "Northeastern Region", "Northwestern Region",
            "Southern Peninsula", "Southern Region", "Western Region", "Westfjords"
        ],
        "Kosovo": [
            "Ferizaj", "Gjakova", "Gjilan", "Mitrovica", "Peja", "Pristina", "Prizren"
        ],
        "Monaco": [
            "Monte Carlo", "La Condamine", "Fontvieille", "La Colle", "Les RÃ©voires",
            "Moneghetti", "Saint Roman", "Larvotto", "La Rousse"
        ],
        "San Marino": [
            "Acquaviva", "Borgo Maggiore", "Chiesanuova", "Domagnano", "Faetano",
            "Fiorentino", "Montegiardino", "San Marino City", "Serravalle"
        ],
        "Vatican City": [
            "Vatican City State"
        ],
        "Kiribati": [
            "Gilbert Islands", "Line Islands", "Phoenix Islands"
        ],
        "Marshall Islands": [
            "Ailinglaplap", "Ailuk", "Arno", "Aur", "Bikini", "Ebon", "Enewetak", "Jabat", "Jaluit",
            "Kili", "Kwajalein", "Lae", "Lib", "Likiep", "Majuro", "Maloelap", "Mejit", "Mili",
            "Namdrik", "Namu", "Rongelap", "Ujae", "Ujelang", "Utirik", "Wotho", "Wotje"
        ],
        "Micronesia": [
            "Chuuk", "Kosrae", "Pohnpei", "Yap"
        ],
        "Nauru": [
            "Aiwo", "Anabar", "Anetan", "Anibare", "Baiti", "Boe", "Buada", "Denigomodu", "Ewa",
            "Ijuw", "Meneng", "Nibok", "Uaboe", "Yaren"
        ],
        "Palau": [
            "Aimeliik", "Airai", "Angaur", "Hatohobei", "Kayangel", "Koror", "Melekeok", "Ngaraard",
            "Ngarchelong", "Ngardmau", "Ngatpang", "Ngchesar", "Ngeremlengui", "Ngiwal", "Peleliu", "Sonsorol"
        ],
        "Samoa": [
            "A'ana", "Aiga-i-le-Tai", "Atua", "Fa'asaleleaga", "Gaga'emauga", "Gaga'ifomauga",
            "Palauli", "Satupa'itea", "Tuamasaga", "Va'a-o-Fonoti", "Vaisigano"
        ],
        "Solomon Islands": [
            "Central Province", "Choiseul", "Guadalcanal", "Honiara City", "Isabel", "Makira-Ulawa",
            "Malaita", "Rennell and Bellona", "Temotu", "Western Province"
        ],
        "Tonga": [
            "Eua", "Ha'apai", "Niuas", "Tongatapu", "Vava'u"
        ],
        "Tuvalu": [
            "Funafuti", "Nanumanga", "Nanumea", "Niulakita", "Niutao", "Nui", "Nukufetau",
            "Nukulaelae", "Vaitupu"
        ],
        "Vanuatu": [
            "Malampa", "Penama", "Sanma", "Shefa", "Tafea", "Torba"
        ],
        "New Zealand": [
            "Auckland", "Bay of Plenty", "Canterbury", "Gisborne", "Hawke's Bay", "Manawatu-Wanganui",
            "Marlborough", "Nelson", "Northland", "Otago", "Southland", "Taranaki", "Tasman",
            "Waikato", "Wellington", "West Coast", "Chatham Islands"
        ],
        "Ghana": [
            "Ahafo", "Ashanti", "Bono", "Bono East", "Central", "Eastern", "Greater Accra", "North East",
            "Northern", "Oti", "Savannah", "Upper East", "Upper West", "Volta", "Western", "Western North"
        ]
    };

    // Return known states if available
    if (countryStates[country]) {
        return countryStates[country];
    }

    // For countries without predefined states, generate placeholder regions
    return [
        `North ${country}`,
        `South ${country}`,
        `East ${country}`,
        `West ${country}`,
        `Central ${country}`,
        `${country} Capital Region`,
        `${country} Coast Region`,
        `${country} Highland Region`,
        `${country} Valley Region`,
        `${country} Border Region`
    ];
}
module.exports = { allCountries, getStates };

